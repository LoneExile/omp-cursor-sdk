import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCursorSdkConnectionStalledError, sanitizeCursorProviderError } from "../src/cursor-provider-errors.js";
import { CURSOR_SDK_BUILDS, type CursorSdkBuild, readCursorSdkBuildSource, readCursorSdkEntrySource } from "./helpers/cursor-sdk-build-source.js";
import { type InstalledBundledSdkInternals, lazyInitializerBefore, loadInstalledBundledSdkInternals } from "./helpers/cursor-sdk-bundled-internals.js";
import { balancedDeclaration, escapeRegExp, IDENT, onlyMatch } from "./helpers/cursor-sdk-minified-source.js";
import { readInstalledPackageVersion } from "./helpers/installed-package.js";

// `isCursorSdkConnectionStalledError` (src/cursor-provider-errors.ts) recognizes the error @cursor/sdk throws when its
// retry policy gives up on a request its stall detector aborted: an internal `RetriableError` (name and kind
// "RetriableError") with the message "Connection stalled" or "Connection stalled repeatedly", which is not a
// ConnectError. The SDK's chunk file names and minified identifiers change between releases, so every build is read by
// content, and the bundled build (what Bun loads) also builds the real errors from its own factory.

const installedSdkVersion = readInstalledPackageVersion("@cursor/sdk");

interface StalledShape {
	message: string;
	title: string;
	isRetryable: boolean;
	when: string;
}

interface RetriableStalledContractFixture {
	provenance: {
		sdkPackage: string;
		sdkVersion: string;
		verified: string;
		builds: string[];
		issues: string[];
	};
	errorShape: {
		classKind: string;
		name: string;
		code: string;
		single: StalledShape & { detail: string };
		repeated: StalledShape & { detailTemplate: string };
	};
	sourceMarkers: string[];
	syntheticStackFrame: string;
}

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/cursor-sdk-retriable-stalled-1.0.40.json", import.meta.url), "utf8"),
) as RetriableStalledContractFixture;
const { single, repeated } = fixture.errorShape;

/** The detail the SDK writes after `retries` counted transport retries: the template counts the stall that just ended the last one too. */
function repeatedDetail(retries: number): string {
	return repeated.detailTemplate.replace("${n}", String(retries + 1));
}

/** The source of `repeatedDetail`: a template literal over the minified call that adds one to the retry count. */
function repeatedDetailPattern(): string {
	const [before, after] = repeated.detailTemplate.split("${n}");
	return `\`${escapeRegExp(before!)}\\$\\{${IDENT}\\(${IDENT}\\)\\}${escapeRegExp(after!)}\``;
}

function makeFixtureRetriableStalledError(message: string): Error & { kind: string } {
	const error = new Error(message) as Error & { kind: string };
	error.name = fixture.errorShape.name;
	error.kind = fixture.errorShape.classKind;
	error.stack = `${fixture.errorShape.name}: ${message}\n    ${fixture.syntheticStackFrame}`;
	return error;
}

interface StalledErrorSource {
	/** The `RetriableError` class as the minifier named it, and where its declaration starts. */
	retriable: { name: string; index: number };
	/** The function that builds both connection-stalled errors. */
	factory: string;
}

/** The connection-stalled errors in one build's text, found by their class kind and messages and never by a minified name. */
function locateStalledErrorSource(text: string, build: CursorSdkBuild): StalledErrorSource {
	const { classKind, code } = fixture.errorShape;
	const kind = onlyMatch(
		text,
		`class (${IDENT}) extends (${IDENT})\\{get kind\\(\\)\\{return${escapeRegExp(JSON.stringify(classKind))}\\}\\}`,
		`${build}: exactly one class has kind ${classKind}`,
	);
	const [, className, baseName] = kind;

	// `name` reads `kind` on the base class, so these errors are named after the class kind.
	const base = onlyMatch(text, `class ${escapeRegExp(baseName!)} extends Error\\{`, `${build}: ${baseName} is the SDK's error base class`);
	expect(balancedDeclaration(text, base.index!), `${build}: the base error no longer names itself by its kind`).toContain("get name(){return this.kind}");

	// Both errors go through the function that sets the `code` property.
	const setter = onlyMatch(
		text,
		`function (${IDENT})\\((${IDENT})\\)\\{return Object\\.defineProperty\\(\\2,"code",\\{value:${escapeRegExp(JSON.stringify(code))},enumerable:!0,configurable:!0\\}\\),\\2\\}`,
		`${build}: the function that sets code ${code}`,
	);
	const construct = (shape: StalledShape, detail: string): string =>
		`${escapeRegExp(setter[1]!)}\\(new ${escapeRegExp(className!)}\\(${escapeRegExp(JSON.stringify(shape.message))},\\{cause:${IDENT},requestId:${IDENT},displayInfo:\\{` +
		`title:${escapeRegExp(JSON.stringify(shape.title))},detail:${detail},isRetryable:!${shape.isRetryable ? 0 : 1},connectCode:${IDENT}\\}\\}\\)\\)`;
	const singleConstruction = onlyMatch(
		text,
		construct(single, escapeRegExp(JSON.stringify(single.detail))),
		`${build}: the "${single.message}" ${classKind} with its title, detail and retryable flag`,
	);
	const repeatedConstruction = onlyMatch(
		text,
		construct(repeated, repeatedDetailPattern()),
		`${build}: the "${repeated.message}" ${classKind} with its title, detail template and retryable flag`,
	);

	// One function builds both.
	const factoryStart = text.lastIndexOf("function ", Math.min(singleConstruction.index!, repeatedConstruction.index!));
	const factory = new RegExp(`^function (${IDENT})\\(`).exec(text.slice(factoryStart))?.[1];
	expect(factory, `${build}: no function declares the connection-stalled errors`).toBeDefined();
	const declaration = balancedDeclaration(text, factoryStart);
	expect(declaration, `${build}: one function no longer builds both messages`).toContain(singleConstruction[0]);
	expect(declaration, `${build}: one function no longer builds both messages`).toContain(repeatedConstruction[0]);

	return { retriable: { name: className!, index: kind.index! }, factory: factory! };
}

// Scanning a multi-megabyte SDK build takes about 1 s unloaded and up to 5 s on a loaded machine, bun's default limit.
const SDK_BUILD_SCAN_TIMEOUT_MS = 30_000;

describe("installed Cursor SDK RetriableError connection-stalled contract", () => {
	it("records the installed @cursor/sdk version and every build it was checked against", () => {
		expect(fixture.provenance.sdkPackage).toBe("@cursor/sdk");
		expect(fixture.provenance.sdkVersion).toBe(installedSdkVersion);
		expect(fixture.provenance.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(fixture.provenance.builds).toEqual([...CURSOR_SDK_BUILDS]);
	});

	it.each(CURSOR_SDK_BUILDS)("%s build throws RetriableError connection-stalled errors with the recorded markers, messages, display text and retryable flag", (build) => {
		const text = readCursorSdkBuildSource(build);
		for (const marker of fixture.sourceMarkers) {
			expect(text, `${build} no longer contains the source marker ${marker}`).toContain(marker);
		}

		const source = locateStalledErrorSource(text, build);

		// The retry policy raises them for an abort the stall detector caused, once retries are used up or capped. Its
		// stall flag is a `stall_detector` abort of an error that is, or became, a RetriableError.
		const stallFlag = onlyMatch(
			text,
			`(${IDENT})=(?:${IDENT}\\.abortOrigin==="stall_detector"|"stall_detector"===${IDENT}\\.abortOrigin)&&!${IDENT}&&\\(${IDENT} instanceof ${IDENT}\\|\\|${IDENT} instanceof ${escapeRegExp(source.retriable.name)}\\)`,
			`${build}: the retry policy's stall flag, a stall_detector abort whose error is a ${fixture.errorShape.classKind}`,
		);
		const factory = escapeRegExp(source.factory);
		const stallBranch = new RegExp(
			`if\\(${escapeRegExp(stallFlag[1]!)}\\)\\{if\\([^{}]*\\)return ${IDENT}\\(${factory}\\(${IDENT}\\(\\)\\),\\{countAsTransportError:!0\\}\\);` +
				`(?:let|const) ${IDENT}=${IDENT}\\(\\(?\\(\\)=>${factory}\\(${IDENT}\\(\\)\\)\\)?,\\(?\\(\\)=>${factory}\\(\\{\\.\\.\\.${IDENT}\\(\\),transportErrorRetries:void 0\\}\\)\\)?\\)`,
		);
		expect(
			text.slice(stallFlag.index!, stallFlag.index! + 3000),
			`${build}: the retry policy no longer throws ${source.factory}(...) for a stall, with the retry count dropped on the first branch`,
		).toMatch(stallBranch);
	}, SDK_BUILD_SCAN_TIMEOUT_MS);

	it.each([
		["Connection stalled", single.message],
		["Connection stalled repeatedly", repeated.message],
	] as const)("classifies a %s error shaped by the fixture as a network failure", (_label, message) => {
		const error = makeFixtureRetriableStalledError(message);

		expect(error.name).toBe("RetriableError");
		expect(error.kind).toBe("RetriableError");
		expect(error.message).toBe(message);
		expect(isCursorSdkConnectionStalledError(error)).toBe(true);
		const sanitized = sanitizeCursorProviderError(error, "test-key");
		expect(sanitized.toLowerCase()).toContain("network error");
		expect(sanitized).not.toMatch(/stalled(?: repeatedly)?/i);
	});
});

/** The bundled build's connection-stalled factory, behind a call that first runs the lazy initializer of the module that declares the error classes. */
function stalledFactoryExportsSource(): string {
	const text = readCursorSdkEntrySource("bundled");
	const source = locateStalledErrorSource(text, "bundled");
	const initializer = lazyInitializerBefore(text, source.retriable.index);
	return `{connectionStalled:(options)=>{${initializer ? `${initializer}();` : ""}return ${source.factory}(options)}}`;
}

interface StalledFactoryOptions {
	cause: unknown;
	requestId: string;
	transportErrorRetries: number | undefined;
	connectCode: number;
}

interface StalledErrorInternals {
	connectionStalled(options: StalledFactoryOptions): Error & {
		kind: string;
		code: string;
		cause: unknown;
		requestId: string;
		displayInfo: { title: string; detail: string; isRetryable: boolean; connectCode: number };
	};
}

describe("the bundled build's own connection-stalled errors", () => {
	let sdk: InstalledBundledSdkInternals<StalledErrorInternals> | undefined;

	beforeAll(async () => {
		sdk = await loadInstalledBundledSdkInternals<StalledErrorInternals>(stalledFactoryExportsSource());
	}, 30_000);

	afterAll(() => sdk?.dispose());

	it.each([
		["no transport retry counted", undefined, single, single.detail],
		["a retry count of 0", 0, single, single.detail],
		["two transport retries", 2, repeated, repeatedDetail(2)],
	] as const)("with %s is a RetriableError the classifier recognizes", (_label, transportErrorRetries, shape, detail) => {
		if (!sdk) throw new Error("bundled SDK internals not loaded");
		const cause = new Error("stream stalled");
		const error = sdk.internals.connectionStalled({ cause, requestId: "req-1", transportErrorRetries, connectCode: 14 });

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe(fixture.errorShape.name);
		expect(error.kind).toBe(fixture.errorShape.classKind);
		expect(error.code).toBe(fixture.errorShape.code);
		expect(error.message).toBe(shape.message);
		expect(error.cause).toBe(cause);
		expect(error.requestId).toBe("req-1");
		expect(error.displayInfo).toEqual({ title: shape.title, detail, isRetryable: shape.isRetryable, connectCode: 14 });
		// Raised inside the SDK, so its stack names it.
		expect(error.stack).toContain("@cursor/sdk");

		expect(isCursorSdkConnectionStalledError(error)).toBe(true);
		const sanitized = sanitizeCursorProviderError(error, "test-key");
		expect(sanitized.toLowerCase()).toContain("network error");
		expect(sanitized).not.toMatch(/stalled(?: repeatedly)?/i);
	});
});
