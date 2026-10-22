import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Code, ConnectError } from "@connectrpc/connect";
import { type CursorAgentError, NetworkError, convertConnectError } from "@cursor/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	classifyCursorConnectError,
	isCursorSdkAbortConnectError,
	isUnauthenticatedConnectError,
	sanitizeCursorProviderError,
} from "../src/cursor-provider-errors.js";
import { CURSOR_SDK_BUILDS, CURSOR_SDK_ROOT, type CursorSdkBuild, readCursorSdkBuildSource, readCursorSdkEntrySource } from "./helpers/cursor-sdk-build-source.js";
import { loadInstalledBundledSdkInternals, lazyInitializerBefore, type InstalledBundledSdkInternals } from "./helpers/cursor-sdk-bundled-internals.js";
import { balancedDeclaration, escapeRegExp, IDENT, onlyMatch } from "./helpers/cursor-sdk-minified-source.js";
import { SDK_BUNDLED_TRANSPORT_FRAMES } from "./helpers/cursor-sdk-process-error-fixtures.js";

// @cursor/sdk's convertConnectError wraps a ConnectError in a NetworkError (Unavailable, DeadlineExceeded,
// Internal) and keeps it on `cause`. The wrapper has neither `details` nor the ConnectError's name, so the
// classifier and the process-error guard have to see through it (upstream #265). Every wrapper here comes from
// the installed SDK's real `convertConnectError` and a real `ConnectError` of the `@connectrpc/connect` copy
// the SDK resolves.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_URL = pathToFileURL(join(REPO, "src/cursor-sdk-process-error-guard.ts")).href;
const FOREIGN_FRAME = "    at file:///repo/node_modules/other-client/dist/transport.js:1:1";
const NETWORK_ERROR_MESSAGE = /Network error: .*failed during network or service I\/O/;

// Each SDK build the package exports map can resolve (import, require, bun) is minified differently, so the
// switch in convertConnectError is matched by shape: `case X.Code.Unavailable:` in esm/cjs, `case X.Unavailable:` in bundled.
const NETWORK_ERROR_BRANCH =
	/case [\w$.]+\.Unavailable:case [\w$.]+\.DeadlineExceeded:case [\w$.]+\.Internal:return new ([\w$]+)\([\w$]+,\{code:[\w$]+,isRetryable:[\w$]+,cause:[\w$]+\}\)/;

type Provenance = "sdk-frame-on-wrapper" | "sdk-frame-on-cause" | "backend-details-on-cause" | "none";

/** A real SDK wrapper around a real ConnectError, with the stacks and details set so only `provenance` ties it to Cursor. */
function makeWrappedConnectError(
	provenance: Provenance,
	options: { code?: Code; message?: string } = {},
): { wrapper: CursorAgentError; raw: ConnectError } {
	const raw = new ConnectError(options.message ?? "Error", options.code ?? Code.Unavailable);
	raw.stack = `ConnectError: ${raw.message}\n${provenance === "sdk-frame-on-cause" ? SDK_BUNDLED_TRANSPORT_FRAMES : FOREIGN_FRAME}`;
	if (provenance === "backend-details-on-cause") {
		raw.details = [{ type: "aiserver.v1.ErrorDetails", value: new Uint8Array() }];
	}
	const wrapper = convertConnectError(raw);
	if (provenance !== "sdk-frame-on-wrapper") {
		wrapper.stack = `${wrapper.name}: ${wrapper.message}\n${FOREIGN_FRAME}`;
	}
	return { wrapper, raw };
}

describe("installed @cursor/sdk convertConnectError NetworkError wrapper (contract)", () => {
	it.each(CURSOR_SDK_BUILDS)("%s build wraps Unavailable, DeadlineExceeded and Internal in NetworkError with the ConnectError as cause", (build) => {
		const source = readCursorSdkBuildSource(build);
		const branch = NETWORK_ERROR_BRANCH.exec(source);
		expect(branch, `${build} no longer maps Unavailable/DeadlineExceeded/Internal to one error class with cause`).not.toBeNull();
		const constructorName = branch?.[1] ?? "";
		const networkErrorClass = new RegExp(
			`class ${escapeRegExp(constructorName)} extends [\\w$]+\\{constructor\\([\\w$]+,[\\w$]+=\\{\\}\\)\\{super\\([\\w$]+,\\{\\.\\.\\.[\\w$]+,errorName:"NetworkError"\\}\\)\\}\\}`,
		);
		expect(networkErrorClass.test(source), `${build}: ${constructorName} is no longer the NetworkError class`).toBe(true);
	});

	it.each([
		[Code.Unavailable, "unavailable"],
		[Code.DeadlineExceeded, "deadline_exceeded"],
		[Code.Internal, "internal"],
	] as const)("the installed SDK wraps ConnectError code %s as a NetworkError with code %s", (connectCode, wrapperCode) => {
		const raw = new ConnectError("Error", connectCode);
		const wrapper = convertConnectError(raw);

		expect(wrapper).toBeInstanceOf(NetworkError);
		expect(wrapper.name).toBe("NetworkError");
		expect(wrapper.code).toBe(wrapperCode);
		expect(wrapper.message).toBe(raw.message);
		expect(wrapper.isRetryable).toBe(false);
		expect(wrapper.cause).toBe(raw);
		expect("details" in wrapper).toBe(false);
		// The wrapper is built inside the SDK, so its own stack is what carries SDK provenance.
		expect(wrapper.stack).toContain("@cursor/sdk");
	});

	it("resolves the same @connectrpc/connect copy as the SDK, so the ConnectError is the one the SDK produces", () => {
		const fromSdk = createRequire(join(CURSOR_SDK_ROOT, "package.json")).resolve("@connectrpc/connect");
		const fromTest = createRequire(import.meta.url).resolve("@connectrpc/connect");
		expect(fromTest).toBe(fromSdk);
	});
});

describe("classifying the SDK NetworkError wrapper of a ConnectError", () => {
	it.each([
		["a Cursor SDK frame on the wrapper", "sdk-frame-on-wrapper", "cursor-sdk-stack"],
		["a Cursor SDK frame on the cause", "sdk-frame-on-cause", "cursor-sdk-stack"],
		["aiserver.* details on the cause", "backend-details-on-cause", "cursor-backend-details"],
		["no Cursor provenance anywhere in the chain", "none", "generic-connect"],
	] as const)("derives provenance from %s", (_name, provenance, source) => {
		const { wrapper } = makeWrappedConnectError(provenance);

		expect(wrapper.name).toBe("NetworkError");
		expect(classifyCursorConnectError(wrapper)).toEqual({ kind: "network", source });
	});

	it("does not take non-aiserver details as Cursor backend provenance", () => {
		const { wrapper, raw } = makeWrappedConnectError("none");
		raw.details = [{ type: "google.rpc.ErrorInfo", value: new Uint8Array() }];

		expect(classifyCursorConnectError(wrapper)).toEqual({ kind: "network", source: "generic-connect" });
	});

	it("classifies a wrapped Internal HTTP/2 stream reset as a network failure", () => {
		const { wrapper } = makeWrappedConnectError("sdk-frame-on-wrapper", {
			code: Code.Internal,
			message: "Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
		});

		expect(wrapper.code).toBe("internal");
		expect(classifyCursorConnectError(wrapper)).toEqual({ kind: "network", source: "cursor-sdk-stack" });
	});

	it("classifies a wrapped Unauthenticated ConnectError as unauthenticated", () => {
		const { wrapper } = makeWrappedConnectError("sdk-frame-on-wrapper", { code: Code.Unauthenticated });

		expect(wrapper.name).toBe("AuthenticationError");
		expect(classifyCursorConnectError(wrapper)).toEqual({ kind: "unauthenticated", source: "cursor-sdk-stack" });
		expect(isUnauthenticatedConnectError(wrapper)).toBe(true);
	});

	it("never classifies a wrapped canceled ConnectError as an abort, even when the wrapper itself looks like one", () => {
		const raw = new ConnectError(
			"This operation was aborted",
			Code.Canceled,
			undefined,
			undefined,
			new DOMException("This operation was aborted", "AbortError"),
		);
		const wrapper = convertConnectError(raw);
		// Every condition of the SDK transport's own abort shape, now on the wrapper: its code, a message that
		// reads as canceled, AbortError in the stack, and SDK frames.
		wrapper.stack = `${wrapper.name}: ${wrapper.message}\n${SDK_BUNDLED_TRANSPORT_FRAMES}\nCaused by: AbortError`;

		expect(wrapper.code).toBe("canceled");
		expect(isCursorSdkAbortConnectError(wrapper)).toBe(false);
		expect(classifyCursorConnectError(wrapper)?.kind).not.toBe("abort");
	});

	it("does not treat a NetworkError without a ConnectError in its cause chain as a connect error", () => {
		// The SDK's own non-Connect NetworkErrors: a failed Cloud API request, and a fetch AbortError.
		const cloudRequestFailure = new NetworkError("Network request failed", {
			isRetryable: true,
			cause: new TypeError("fetch failed"),
		});
		const fetchAbort = new NetworkError("This operation was aborted", {
			code: "ABORT_ERR",
			isRetryable: true,
			cause: new DOMException("This operation was aborted", "AbortError"),
		});

		expect(classifyCursorConnectError(cloudRequestFailure)).toBeUndefined();
		expect(classifyCursorConnectError(fetchAbort)).toBeUndefined();
	});

	it("terminates on a cyclic cause chain and still finds the ConnectError in it", () => {
		const { wrapper, raw } = makeWrappedConnectError("sdk-frame-on-wrapper");
		raw.cause = wrapper;
		const selfCause = new Error("loop");
		selfCause.cause = selfCause;

		expect(classifyCursorConnectError(wrapper)).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(classifyCursorConnectError(selfCause)).toBeUndefined();
	});

	it("does not find a ConnectError at the bottom of a deep cause chain", () => {
		let error: Error = convertConnectError(new ConnectError("Error", Code.Unavailable));
		for (let depth = 0; depth < 1_000; depth += 1) error = new Error(`wrapper ${depth}`, { cause: error });

		expect(classifyCursorConnectError(error)).toBeUndefined();
	});
});

// The wrapped abort: an abort reaches the host as an Unknown ConnectError around a canceled ConnectError around an
// AbortError. The bundled builds of 1.0.34, 1.0.37 and 1.0.40 all build that chain (checked by running each one's own
// transport conversion and ConnectError class); only the installed build is pinned here. Two ConnectError classes are
// involved. The Node transport the SDK ships converts the abort reason with `ConnectError.from` of the
// `@connectrpc/connect` copy it resolves, which makes a canceled ConnectError and (the SDK sets it itself) keeps the
// AbortError as its `cause`. The SDK's own vendored ConnectError class has no `Symbol.hasInstance`, so the unary call's
// `from` does not recognize that instance, and wraps it as Unknown with the canceled one as `cause`. The pins below
// read that out of every installed build; the second describe runs it, from the bundled build's own code.
describe("installed @cursor/sdk wrapped abort (contract)", () => {
	it.each(CURSOR_SDK_BUILDS)("%s build: the transport keeps the abort reason as the canceled ConnectError's cause, and the SDK's own ConnectError wraps that error as Unknown", (build) => {
		const text = readCursorSdkBuildSource(build);

		// The transport's error conversion: a new ConnectError gets the original reason as its cause.
		const conversion = onlyMatch(
			text,
			`(?:let|const) (${IDENT})=(${IDENT})(?:\\.ConnectError)?\\.from\\((${IDENT}),(${IDENT})\\);` +
				`(?:if\\(\\1!==\\3\\)\\1\\.cause=\\3;return \\1|return \\1!==\\3&&\\(\\1\\.cause=\\3\\),\\1)\\}`,
			`${build}: the transport conversion keeps the reason as cause`,
		);
		// ...and that ConnectError is the one of `@connectrpc/connect`, not the SDK's own class.
		const external = escapeRegExp(conversion[2]!);
		expect(text, `${build}: ${conversion[2]} is @connectrpc/connect's ConnectError`).toMatch(
			new RegExp(`ConnectError as ${external}[,}]|[,; ]${external}=${IDENT}\\("@connectrpc/connect"\\)`),
		);

		// The SDK's own class: it recognizes only its own instances, so a foreign canceled ConnectError is wrapped
		// (Unknown by default, the original as cause), and only an AbortError is turned into Canceled.
		const header = onlyMatch(
			text,
			`class (${IDENT}) extends Error\\{constructor\\((${IDENT}),(${IDENT})=${IDENT}(?:\\.${IDENT})?\\.Unknown,${IDENT},${IDENT},${IDENT}\\)\\{super\\(`,
			`${build}: the SDK's own ConnectError class`,
		);
		const declaration = balancedDeclaration(text, header.index!);
		expect(declaration).toContain('this.name="ConnectError"');
		expect(declaration).not.toContain("hasInstance");
		expect(declaration).toMatch(new RegExp(`static from\\((${IDENT}),(${IDENT})=`));
		expect(declaration).toContain(`instanceof ${header[1]}`);
		expect(declaration).toMatch(/"AbortError"==|\.name=="AbortError"/);
		expect(declaration).toMatch(new RegExp(`new ${escapeRegExp(header[1]!)}\\(${IDENT}\\.message,${IDENT},void 0,void 0,${IDENT}\\)`));

		// The unary call passes whatever the transport rejected with through that `from`.
		onlyMatch(
			text,
			`(?:let|const) (${IDENT})=${IDENT}(?:\\.${IDENT})*\\.from\\(${IDENT}\\.aborted\\?(?:\\(0,[\\w$.]+\\)|${IDENT})\\(${IDENT}\\):${IDENT}\\);` +
				`return ${IDENT}\\.abort\\(\\1\\),${IDENT}\\(\\),Promise\\.reject\\(\\1\\)`,
			`${build}: the unary call wraps the transport's rejection with the SDK's ConnectError.from`,
		);
	});
});

// The stall detector's cancellation. The SDK's bidirectional-stream stall detector cancels a stalled request through the
// same AbortController as a user abort does, so the wrapped abort above has the same shape either way, and
// `isCursorSdkStallAbortNetworkError` (src/cursor-provider-errors.ts) tells the two apart by the stack the cancellation
// leaves: the detector's `reportStall` runs its `onStall` callback, the SDK wires that callback to the request's cancel
// function, and the AbortController that function aborts records the call stack. The pins below read that chain out of
// every installed build, so a rebuilt SDK that renames or reroutes it fails here and not as a stalled request that is
// reported as a user abort; the last describe runs the bundled build's own detector and classifies the stack Bun records.
const STALL_CLASSIFIER_REVERIFY =
	"isCursorSdkStallAbortNetworkError (src/cursor-provider-errors.ts) tells the stall detector's cancellation from a user abort by the detector's `onStall` and `reportStall` stack frames, so the stall/abort classifier needs re-verification against this SDK build";

/** A failure message for a stall detector pin: what no longer holds in `build`, and that the classifier needs re-verifying. */
function stallPin(build: CursorSdkBuild, fact: string): string {
	return `${build}: ${fact}; ${STALL_CLASSIFIER_REVERIFY}`;
}

interface StallDetectorSource {
	/** The detector class as the minifier named it. */
	name: string;
	/** Offset of the class header in the text it was located in. */
	index: number;
	/** The class's source. */
	declaration: string;
	/** The `reportStall(...)` method's source. */
	reportStall: string;
}

/** The stall detector, found by the `reportStall` method it declares and never by a minified name. */
function locateStallDetector(text: string, build: CursorSdkBuild): StallDetectorSource {
	const method = onlyMatch(text, `(?<![.\\w$])reportStall\\(${IDENT},${IDENT}\\)\\{`, stallPin(build, "the build declares exactly one reportStall method"));
	const headers = text.slice(0, method.index).matchAll(new RegExp(`(?<![\\w$])class (${IDENT})(?: extends ${IDENT}(?:\\.${IDENT})*)?\\{`, "g"));
	const header = [...headers].at(-1);
	expect(header, stallPin(build, "reportStall is declared inside a class")).toBeDefined();
	const declaration = balancedDeclaration(text, header!.index!);
	expect(header!.index! + declaration.length, stallPin(build, "reportStall is a method of the class that precedes it")).toBeGreaterThan(method.index!);
	return { name: header![1]!, index: header!.index!, declaration, reportStall: balancedDeclaration(text, method.index!) };
}

// Scanning a multi-megabyte SDK build takes about 1 s unloaded and up to 5 s on a loaded machine, bun's default limit.
const SDK_BUILD_SCAN_TIMEOUT_MS = 30_000;

describe("installed @cursor/sdk stall detector (contract for the stall/abort classifier)", () => {
	it.each(CURSOR_SDK_BUILDS)("%s build: reportStall runs this.onStall?.(), and only onStallDetected calls reportStall", (build) => {
		const text = readCursorSdkBuildSource(build);
		const detector = locateStallDetector(text, build);

		// `reportStall` is a method name and `onStall` a property name, so the minifier keeps both: they are the frame names.
		expect(detector.reportStall, stallPin(build, "reportStall no longer calls this.onStall?.()")).toContain("this.onStall?.()");

		const detected = onlyMatch(text, `(?<![.\\w$])onStallDetected\\(${IDENT}\\)\\{`, stallPin(build, "the build declares exactly one onStallDetected method"));
		const detectedBody = balancedDeclaration(text, detected.index!);
		expect(detector.declaration, stallPin(build, "onStallDetected is a method of the class that declares reportStall")).toContain(detectedBody);
		const callers = text.match(/this\.reportStall\(/g)?.length ?? 0;
		expect(callers, stallPin(build, "nothing calls reportStall")).toBeGreaterThan(0);
		expect(detectedBody.match(/this\.reportStall\(/g)?.length ?? 0, stallPin(build, "reportStall is called from outside onStallDetected")).toBe(callers);
		for (const reason of ["no_activity", "heartbeat_only"]) {
			expect(text, stallPin(build, `a detector timer no longer calls this.onStallDetected("${reason}")`)).toContain(`this.onStallDetected("${reason}")`);
		}
	}, SDK_BUILD_SCAN_TIMEOUT_MS);

	it.each(CURSOR_SDK_BUILDS)("%s build: the SDK gives the detector an onStall callback that aborts the request's linked AbortController synchronously", (build) => {
		const text = readCursorSdkBuildSource(build);
		const detector = locateStallDetector(text, build);

		// The property key names the arrow function `onStall`, the frame name the classifier reads, and the callback calls
		// the cancel function that `withCancel()` returned beside the context the detector watches.
		const wiring = onlyMatch(
			text,
			`new ${escapeRegExp(detector.name)}\\((${IDENT}),\\{[^{}]*onStall:\\(\\)=>\\{${IDENT}\\("stall_detector",\\{[^{}]*\\}\\),(${IDENT})\\(\\)\\}`,
			stallPin(build, "the SDK builds its stall detector with an `onStall:()=>{...,cancel()}` callback"),
		);
		const bindings = [
			...text
				.slice(Math.max(0, wiring.index! - 3000), wiring.index!)
				.matchAll(new RegExp(`(?:let|const)\\[(${IDENT}),(${IDENT})\\]=${IDENT}\\.withCancel\\(\\)`, "g")),
		];
		const binding = bindings.at(-1);
		expect(
			[binding?.[1], binding?.[2]],
			stallPin(build, "the detector's context and its onStall cancel function are no longer the two results of one withCancel()"),
		).toEqual([wiring[1], wiring[2]]);

		// `withCancel()` hands out `(reason) => linked.abort(reason)`, and that handle aborts its AbortController in the
		// same call, so the abort's stack still holds `onStall` and `reportStall`.
		const definitions = text.match(/(?<![.\w$])withCancel\(\)\{/g)?.length ?? 0;
		const cancelling = text.match(
			new RegExp(`(?<![.\\w$])withCancel\\(\\)\\{(?:let|const) (${IDENT})=${IDENT}\\(this\\.signal\\);return\\[new ${IDENT}\\(this,\\1\\.signal\\),\\(?(${IDENT})\\)?=>\\1\\.abort\\(\\2\\)\\]\\}`, "g"),
		);
		expect(definitions, stallPin(build, "the build has no withCancel() method")).toBeGreaterThan(0);
		expect(cancelling?.length, stallPin(build, "a withCancel() no longer returns (reason) => linked.abort(reason)")).toBe(definitions);
		const linked = text.match(
			new RegExp(
				`(?:let|const) (${IDENT})=new AbortController;if\\((${IDENT})\\.aborted\\)return \\1\\.abort\\(\\2\\.reason\\),\\{signal:\\1\\.signal,abort\\((${IDENT})\\)\\{\\1\\.abort\\(\\3\\)\\},unlink\\(\\)\\{\\}\\};` +
					`(?:let|const) (${IDENT})=\\(\\)=>\\1\\.abort\\(\\2\\.reason\\);return \\2\\.addEventListener\\("abort",\\4,\\{once:!0\\}\\),\\{signal:\\1\\.signal,abort\\((${IDENT})\\)\\{\\2\\.removeEventListener\\("abort",\\4\\),\\1\\.abort\\(\\5\\)\\}`,
				"g",
			),
		);
		expect(linked?.length, stallPin(build, "the linked child controller no longer aborts its AbortController synchronously in abort(reason)")).toBe(definitions);
	}, SDK_BUILD_SCAN_TIMEOUT_MS);
});

/** `{ConnectError, fromNodeReason, StallDetector}` over the bundle's top-level names: the transport's conversion, the SDK's own ConnectError class, and its stall detector. */
function bundledInternalsSource(): string {
	const text = readCursorSdkEntrySource("bundled");
	const conversion = onlyMatch(
		text,
		`let (${IDENT})=(${IDENT})\\.from\\((${IDENT}),(${IDENT})\\);if\\(\\1!==\\3\\)\\1\\.cause=\\3;return \\1\\}`,
		"bundled: the transport's error conversion",
	);
	const converter = new RegExp(`function (${IDENT})\\(`).exec(text.slice(text.lastIndexOf("function ", conversion.index!)));
	const klass = onlyMatch(
		text,
		`(${IDENT})=class \\1 extends Error\\{constructor\\(${IDENT},${IDENT}=${IDENT}\\.Unknown,${IDENT},${IDENT},${IDENT}\\)\\{super\\(${IDENT}\\(${IDENT},${IDENT}\\)\\);this\\.name="ConnectError"`,
		"bundled: the SDK's own ConnectError class, assigned inside a lazy module initializer",
	);
	const initializer = lazyInitializerBefore(text, klass.index!);
	if (!converter || !initializer) throw new Error("bundled: transport conversion or ConnectError initializer not found");
	const detector = locateStallDetector(text, "bundled");
	const detectorInitializer = lazyInitializerBefore(text, detector.index);
	return (
		`{ConnectError:()=>{${initializer}();return ${klass[1]}},fromNodeReason:${converter[1]},` +
		`StallDetector:()=>{${detectorInitializer ? `${detectorInitializer}();` : ""}return ${detector.name}}}`
	);
}

/** The stall detector class. It reaches the SDK's logger and metrics through `ctx.get(...)`. */
type StallDetectorClass = new (
	ctx: { signal: AbortSignal; get(key: unknown): unknown },
	options: { thresholdMs: number; onStall: () => void },
) => { [Symbol.dispose](): void };

interface BundledInternals {
	ConnectError: () => { from(reason: unknown): ConnectError };
	fromNodeReason(reason: unknown): ConnectError;
	StallDetector: () => StallDetectorClass;
}

describe("the SDK's wrapped abort and stall abort, built by the bundled build's own code", () => {
	let sdk: InstalledBundledSdkInternals<BundledInternals> | undefined;

	beforeAll(async () => {
		sdk = await loadInstalledBundledSdkInternals<BundledInternals>(bundledInternalsSource());
	}, 30_000);

	afterAll(() => sdk?.dispose());

	/** The abort the transport sees, converted by the transport and then wrapped by the SDK's own ConnectError.from. */
	function wrappedAbort(abort: Error = new DOMException("This operation was aborted", "AbortError")): { wrapped: ConnectError; canceled: ConnectError; abort: Error } {
		if (!sdk) throw new Error("bundled SDK internals not loaded");
		const canceled = sdk.internals.fromNodeReason(abort);
		return { wrapped: sdk.internals.ConnectError().from(canceled), canceled, abort };
	}

	/**
	 * The reason of the AbortController that the bundled build's own stall detector aborts once its request goes quiet,
	 * the way the SDK's `onStall` callback does through `withCancel()`. The real `reportStall` runs, over a context whose
	 * `get` returns an inert stand-in for the logger and metrics the SDK would look up.
	 */
	async function stallAbortReason(): Promise<Error> {
		if (!sdk) throw new Error("bundled SDK internals not loaded");
		const Detector = sdk.internals.StallDetector();
		const inert: unknown = new Proxy(() => {}, { get: () => inert, apply: () => inert });
		const request = new AbortController();
		const promise = new Promise<Error>((resolve) => {
			request.signal.addEventListener("abort", () => resolve(request.signal.reason as Error), { once: true });
		});
		// The detector's own timer fires after `thresholdMs` of real time; the test awaits the abort it causes.
		const detector = new Detector({ signal: new AbortController().signal, get: () => inert }, { thresholdMs: 20, onStall: () => request.abort() });
		try {
			return await promise;
		} finally {
			detector[Symbol.dispose]();
		}
	}

	it("is an Unknown ConnectError around a canceled ConnectError around the AbortError", () => {
		const { wrapped, canceled, abort } = wrappedAbort();

		expect(canceled.name).toBe("ConnectError");
		expect(canceled.code).toBe(Code.Canceled);
		expect(canceled.rawMessage).toBe("This operation was aborted");
		expect(canceled.cause).toBe(abort);
		expect(wrapped.name).toBe("ConnectError");
		expect(wrapped.code).toBe(Code.Unknown);
		expect(wrapped.rawMessage).toBe("[canceled] This operation was aborted");
		expect(wrapped.message).toBe("[unknown] [canceled] This operation was aborted");
		expect(wrapped.cause).toBe(canceled);
		// Raised inside the SDK, so its stack names it.
		expect(wrapped.stack).toContain("node_modules/@cursor/sdk/dist/bundled/index.js");
	});

	it("is an abort", () => {
		const { wrapped } = wrappedAbort();

		expect(classifyCursorConnectError(wrapped)).toEqual({ kind: "abort", source: "cursor-sdk-stack" });
		expect(isCursorSdkAbortConnectError(wrapped)).toBe(true);
	});

	it("is not an abort when its stack never names the Cursor SDK", () => {
		const { wrapped } = wrappedAbort();
		wrapped.stack = `ConnectError: ${wrapped.message}\n${FOREIGN_FRAME}`;

		expect(classifyCursorConnectError(wrapped)).toBeUndefined();
		expect(isCursorSdkAbortConnectError(wrapped)).toBe(false);
	});

	it("is a retryable network failure, not an abort, when the stall detector raised the AbortError", () => {
		const stall = new DOMException("This operation was aborted", "AbortError");
		// The frames the detector leaves where it aborts: its `reportStall` runs the `onStall` callback that cancels. This
		// stack is synthetic; the next test runs the bundled build's own detector.
		stall.stack =
			"AbortError: This operation was aborted\n" +
			"    at abort (file:///repo/node_modules/@cursor/sdk/dist/bundled/index.js:3:2000)\n" +
			"    at reportStall (file:///repo/node_modules/@cursor/sdk/dist/bundled/index.js:3:2100)";
		const { wrapped } = wrappedAbort(stall);

		expect(classifyCursorConnectError(wrapped)).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(isCursorSdkAbortConnectError(wrapped)).toBe(false);
	});

	it("is a retryable network failure, not an abort, when the bundled build's own stall detector aborts the request", async () => {
		const stall = await stallAbortReason();

		// What the classifier reads: the detector's own frame, inside the SDK, on the stack the AbortController recorded.
		expect(stall.stack, "the stall detector's reportStall frame is missing from the abort's stack").toMatch(
			/\breportStall\b[^\n]*node_modules\/@cursor\/sdk\/dist\/bundled\/index\.js/,
		);
		const { wrapped } = wrappedAbort(stall);

		expect(classifyCursorConnectError(wrapped)).toEqual({ kind: "network", source: "cursor-sdk-stack" });
		expect(isCursorSdkAbortConnectError(wrapped)).toBe(false);
	});

	it("is not an abort when the canceled ConnectError beneath it has no AbortError cause", () => {
		const { wrapped, canceled } = wrappedAbort();
		canceled.cause = undefined;

		expect(classifyCursorConnectError(wrapped)).toBeUndefined();
	});

	it("is not an abort when the canceled ConnectError beneath it is another code", () => {
		const { wrapped, canceled } = wrappedAbort();
		Object.assign(canceled, { code: Code.Unavailable });

		expect(classifyCursorConnectError(wrapped)?.kind).not.toBe("abort");
	});

	it("is not an abort once the SDK has wrapped it as a NetworkError or any other error", () => {
		const { wrapped } = wrappedAbort();
		const networkError = new NetworkError("This operation was aborted", { code: "ABORT_ERR", isRetryable: true, cause: wrapped });
		const other = new Error("request failed", { cause: wrapped });
		other.stack = `Error: request failed\n${SDK_BUNDLED_TRANSPORT_FRAMES}`;

		expect(classifyCursorConnectError(networkError)?.kind).not.toBe("abort");
		expect(classifyCursorConnectError(other)?.kind).not.toBe("abort");
	});

	it("is not reported as a retryable network failure, which omp would retry", () => {
		const { wrapped } = wrappedAbort();

		expect(sanitizeCursorProviderError(wrapped, "sk-test-secret")).not.toMatch(NETWORK_ERROR_MESSAGE);
	});
});

describe("sanitizing the SDK NetworkError wrapper of a ConnectError", () => {
	it("replaces the wrapper's message with the retryable network message and keeps the key out of it", () => {
		const { wrapper } = makeWrappedConnectError("sdk-frame-on-wrapper", {
			message: "backend unavailable for sk-test-secret",
		});
		expect(wrapper.message).toContain("backend unavailable");

		const message = sanitizeCursorProviderError(wrapper, "sk-test-secret");

		expect(message).toMatch(NETWORK_ERROR_MESSAGE);
		expect(message).toMatch(/network.?error/i);
		expect(message).not.toContain("sk-test-secret");
		expect(message).not.toContain("backend unavailable");
		expect(message).not.toContain("[unavailable]");
	});

	it("gives the same message to a wrapper that has no Cursor provenance", () => {
		const { wrapper } = makeWrappedConnectError("none");

		expect(sanitizeCursorProviderError(wrapper, "sk-test-secret")).toMatch(NETWORK_ERROR_MESSAGE);
	});

	it("keeps the message of a wrapper that is not a transport failure", () => {
		const cloudRequestFailure = new NetworkError("Network request failed", {
			isRetryable: true,
			cause: new TypeError("fetch failed"),
		});

		expect(sanitizeCursorProviderError(cloudRequestFailure, "sk-test-secret")).toBe("Network request failed");
	});
});

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Each case blocks in spawnSync, so it needs a per-test timeout above Bun's 5s default.
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;

/** A child environment that keeps omp's state and logs under a throwaway home, away from the maintainer's. */
function isolatedOmpEnv(root: string): Record<string, string | undefined> {
	const home = join(root, "home");
	mkdirSync(home);
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") };
	delete env.XDG_STATE_HOME;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	return env;
}

/**
 * Rejects with a real SDK NetworkError wrapper in a Bun process that imports omp's real postmortem handlers
 * (pi-utils) and the guard module, with a provider-turn guard installed. A host handler registered ahead of the
 * guard sees every rejection first and never claims one, so the run records what reached the host either way.
 * `provenance` is the script that leaves `wrapper` and `raw` with the chosen provenance.
 */
function rejectWrapperInOmpHost(provenance: string): { status: number | null; output: string } {
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-network-wrapper-"));
	tempRoots.push(root);
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { postmortem } from "@oh-my-pi/pi-utils";
import { Code, ConnectError } from "@connectrpc/connect";
import { convertConnectError } from "@cursor/sdk";
import { installCursorSdkProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
const foreignFrame = ${JSON.stringify(FOREIGN_FRAME)};
const rejectionReachedHost = new Promise((resolve) => {
	postmortem.interceptUnhandledRejections((reason) => {
		resolve(reason);
		return false;
	});
});
installCursorSdkProcessErrorGuard();
const raw = new ConnectError("backend unavailable", Code.Unavailable);
raw.stack = "ConnectError: [unavailable] backend unavailable\\n" + foreignFrame;
const wrapper = convertConnectError(raw);
${provenance}
void Promise.reject(wrapper);
const reason = await rejectionReachedHost;
console.log("host handler saw: " + reason.name + " code " + reason.code);
`,
		],
		{ cwd: REPO, env: isolatedOmpEnv(root), encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const FOREIGN_WRAPPER_STACK = `wrapper.stack = wrapper.name + ": " + wrapper.message + "\\n" + foreignFrame;`;

describe("process-error guard and the SDK NetworkError wrapper of a ConnectError", () => {
	it("contains an unhandled rejection of the wrapper the SDK raised while a provider turn is active", () => {
		// `convertConnectError` runs inside the SDK, so the wrapper's own stack carries its frames.
		const run = rejectWrapperInOmpHost("");

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: NetworkError code unavailable");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("contains the wrapper of a ConnectError that carries aiserver.* details when no stack names the SDK", () => {
		const run = rejectWrapperInOmpHost(
			`${FOREIGN_WRAPPER_STACK}\nraw.details = [{ type: "aiserver.v1.ErrorDetails", value: new Uint8Array() }];`,
		);

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: NetworkError code unavailable");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps the wrapper fatal when nothing in its cause chain names the Cursor SDK", () => {
		const run = rejectWrapperInOmpHost(FOREIGN_WRAPPER_STACK);

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: NetworkError code unavailable");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);
});

/**
 * Rejects with the wrapped abort (an Unknown ConnectError around a canceled ConnectError around an AbortError)
 * in the same Bun host. The chain is built from the `@connectrpc/connect` copy the SDK resolves, the way the
 * SDK's transport builds it; `sdkFrames` decides whether the outer error's stack names the SDK.
 */
function rejectWrappedAbortInOmpHost(options: { suppressAbortErrors: boolean; sdkFrames: boolean }): { status: number | null; output: string } {
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-wrapped-abort-"));
	tempRoots.push(root);
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { postmortem } from "@oh-my-pi/pi-utils";
import { Code, ConnectError } from "@connectrpc/connect";
import { installCursorSdkProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
const rejectionReachedHost = new Promise((resolve) => {
	postmortem.interceptUnhandledRejections((reason) => {
		resolve(reason);
		return false;
	});
});
const guard = installCursorSdkProcessErrorGuard();
${options.suppressAbortErrors ? "guard.suppressAbortErrors();" : ""}
const abort = new DOMException("This operation was aborted", "AbortError");
const canceled = ConnectError.from(abort, Code.Internal);
canceled.cause = abort;
const wrapped = new ConnectError(canceled.message, Code.Unknown, undefined, undefined, canceled);
wrapped.stack = "ConnectError: " + wrapped.message + "\\n" + ${JSON.stringify(options.sdkFrames ? SDK_BUNDLED_TRANSPORT_FRAMES : FOREIGN_FRAME)};
void Promise.reject(wrapped);
const reason = await rejectionReachedHost;
console.log("host handler saw: " + reason.name + " code " + reason.code + " cause code " + reason.cause.code);
`,
		],
		{ cwd: REPO, env: isolatedOmpEnv(root), encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("process-error guard and the SDK's wrapped abort", () => {
	it("contains the wrapped abort once the turn asked to suppress aborts", () => {
		const run = rejectWrappedAbortInOmpHost({ suppressAbortErrors: true, sdkFrames: true });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: ConnectError code 2 cause code 1");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("treats it as an abort, which the guard contains only for a turn that asked to suppress them", () => {
		const run = rejectWrappedAbortInOmpHost({ suppressAbortErrors: false, sdkFrames: true });

		expect(run.status).toBe(1);
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps a wrapped abort whose stack never names the Cursor SDK fatal", () => {
		const run = rejectWrappedAbortInOmpHost({ suppressAbortErrors: true, sdkFrames: false });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ConnectError code 2 cause code 1");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);
});
