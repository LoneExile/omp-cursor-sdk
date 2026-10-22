import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Code, ConnectError } from "@connectrpc/connect";
import { type CursorAgentError, NetworkError, convertConnectError } from "@cursor/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyCursorConnectError,
	isCursorSdkAbortConnectError,
	isUnauthenticatedConnectError,
	sanitizeCursorProviderError,
} from "../src/cursor-provider-errors.js";
import { SDK_BUNDLED_TRANSPORT_FRAMES } from "./helpers/cursor-sdk-process-error-fixtures.js";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";

// @cursor/sdk's convertConnectError wraps a ConnectError in a NetworkError (Unavailable, DeadlineExceeded,
// Internal) and keeps it on `cause`. The wrapper has neither `details` nor the ConnectError's name, so the
// classifier and the process-error guard have to see through it (upstream #265). Every wrapper here comes from
// the installed SDK's real `convertConnectError` and a real `ConnectError` of the `@connectrpc/connect` copy
// the SDK resolves.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
const GUARD_URL = pathToFileURL(join(REPO, "src/cursor-sdk-process-error-guard.ts")).href;
const FOREIGN_FRAME = "    at file:///repo/node_modules/other-client/dist/transport.js:1:1";
const NETWORK_ERROR_MESSAGE = /Network error: .*failed during network or service I\/O/;

// Each SDK entry the package exports map can resolve (import, require, bun) is minified differently, so the
// switch in convertConnectError is matched by shape: `case X.Code.Unavailable:` in esm/cjs, `case X.Unavailable:` in bundled.
const SDK_ENTRIES = ["dist/esm/index.js", "dist/cjs/index.js", "dist/bundled/index.js"] as const;
const NETWORK_ERROR_BRANCH =
	/case [\w$.]+\.Unavailable:case [\w$.]+\.DeadlineExceeded:case [\w$.]+\.Internal:return new ([\w$]+)\([\w$]+,\{code:[\w$]+,isRetryable:[\w$]+,cause:[\w$]+\}\)/;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
	it.each(SDK_ENTRIES)("%s wraps Unavailable, DeadlineExceeded and Internal in NetworkError with the ConnectError as cause", (entry) => {
		const source = readFileSync(join(sdkRoot, entry), "utf8");
		const branch = NETWORK_ERROR_BRANCH.exec(source);
		expect(branch, `${entry} no longer maps Unavailable/DeadlineExceeded/Internal to one error class with cause`).not.toBeNull();
		const constructorName = branch?.[1] ?? "";
		const networkErrorClass = new RegExp(
			`class ${escapeRegExp(constructorName)} extends [\\w$]+\\{constructor\\([\\w$]+,[\\w$]+=\\{\\}\\)\\{super\\([\\w$]+,\\{\\.\\.\\.[\\w$]+,errorName:"NetworkError"\\}\\)\\}\\}`,
		);
		expect(networkErrorClass.test(source), `${entry}: ${constructorName} is no longer the NetworkError class`).toBe(true);
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
		const fromSdk = createRequire(join(sdkRoot, "package.json")).resolve("@connectrpc/connect");
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

/**
 * Rejects with a real SDK NetworkError wrapper in a Bun process that imports omp's real postmortem handlers
 * (pi-utils) and the guard module, with a provider-turn guard installed. A host handler registered ahead of the
 * guard sees every rejection first and never claims one, so the run records what reached the host either way.
 * `provenance` is the script that leaves `wrapper` and `raw` with the chosen provenance.
 */
function rejectWrapperInOmpHost(provenance: string): { status: number | null; output: string } {
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-network-wrapper-"));
	tempRoots.push(root);
	const home = join(root, "home");
	mkdirSync(home);
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") };
	delete env.XDG_STATE_HOME;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { postmortem } from "@oh-my-pi/pi-utils";
import { Code, ConnectError } from "@connectrpc/connect";
import { convertConnectError } from "@cursor/sdk";
import { installCursorSdkProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
const foreignFrame = ${JSON.stringify(FOREIGN_FRAME)};
const rejectionReachedHost = Promise.withResolvers();
postmortem.interceptUnhandledRejections((reason) => {
	rejectionReachedHost.resolve(reason);
	return false;
});
installCursorSdkProcessErrorGuard();
const raw = new ConnectError("backend unavailable", Code.Unavailable);
raw.stack = "ConnectError: [unavailable] backend unavailable\\n" + foreignFrame;
const wrapper = convertConnectError(raw);
${provenance}
void Promise.reject(wrapper);
const reason = await rejectionReachedHost.promise;
console.log("host handler saw: " + reason.name + " code " + reason.code);
`,
		],
		{ cwd: REPO, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
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
