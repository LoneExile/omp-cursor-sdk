import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_TREE_SITTER_VENDOR_DIR_ENV,
	CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES,
	ensureCursorTreeSitterVendorDir,
	resolveBundledCursorRipgrepPath,
} from "../src/cursor-ripgrep-path.js";
import { CURSOR_SDK_BUILDS, readCursorSdkBuildSource } from "./helpers/cursor-sdk-build-source.js";
import { escapeRegExp, IDENT, onlyMatch } from "./helpers/cursor-sdk-minified-source.js";

const require = createRequire(import.meta.url);
const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
const rgBinaryName = process.platform === "win32" ? "rg.exe" : "rg";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const firstLoadChildScript = join(repoRoot, "test", "helpers", "cursor-sdk-first-load-child.ts");
const originalVendorDir = process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV];

/** The installed platform package for this machine, or `undefined` when the optional dependency is absent. */
function findInstalledPlatformPackageDir(): string | undefined {
	try {
		const sdkEntry = require.resolve("@cursor/sdk");
		return dirname(require.resolve(`${platformPackage}/package.json`, { paths: [dirname(sdkEntry)] }));
	} catch {
		return undefined;
	}
}

const installedPlatformPackageDir = findInstalledPlatformPackageDir();

interface Consumer {
	moduleUrl: URL;
	hoistedPlatformDir: string;
	nestedPlatformDir: string;
}

/**
 * A module whose `@cursor/sdk` package has no entry point, so `require.resolve("@cursor/sdk")` throws
 * as it does inside a compiled Bun binary and only the on-disk `node_modules` chain can find the
 * platform package, hoisted beside the SDK or nested under it.
 */
function makeConsumer(directory: string): Consumer {
	const consumerDir = join(directory, "consumer");
	const consumerModule = join(consumerDir, "index.js");
	const sdkDir = join(consumerDir, "node_modules", "@cursor", "sdk");
	mkdirSync(sdkDir, { recursive: true });
	writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.34" }));
	writeFileSync(consumerModule, "export {};\n");
	expect(() => createRequire(consumerModule).resolve("@cursor/sdk")).toThrow();
	return {
		moduleUrl: pathToFileURL(consumerModule),
		hoistedPlatformDir: join(consumerDir, "node_modules", platformPackage),
		nestedPlatformDir: join(sdkDir, "node_modules", platformPackage),
	};
}

/**
 * Write a platform package whose `vendor/<name>/index.js` exists only for `parsersWithEntrypoint`; the
 * other parser directories still exist, holding a file that is not the entrypoint.
 */
function writePlatformPackage(
	directory: string,
	parsersWithEntrypoint: readonly string[] = CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES,
): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: platformPackage, version: "1.0.34" }));
	for (const name of CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES) {
		const parserDir = join(directory, "vendor", name);
		mkdirSync(parserDir, { recursive: true });
		writeFileSync(join(parserDir, "package.json"), JSON.stringify({ name }));
		if (parsersWithEntrypoint.includes(name)) writeFileSync(join(parserDir, "index.js"), "module.exports = {};\n");
	}
}

function writeRipgrep(directory: string): string {
	const binDir = join(directory, "bin");
	const ripgrep = join(binDir, rgBinaryName);
	mkdirSync(binDir, { recursive: true });
	writeFileSync(ripgrep, "#!/bin/sh\nexit 0\n");
	chmodSync(ripgrep, 0o755);
	return ripgrep;
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-cursor-tree-sitter-"));
	delete process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (originalVendorDir === undefined) delete process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV];
	else process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV] = originalVendorDir;
});

describe("ensureCursorTreeSitterVendorDir", () => {
	it("sets the variable to the platform package's vendor directory when it is unset", () => {
		const consumer = makeConsumer(root);
		writePlatformPackage(consumer.hoistedPlatformDir);

		const vendorDir = ensureCursorTreeSitterVendorDir(consumer.moduleUrl);

		expect(vendorDir).toBe(join(realpathSync(consumer.hoistedPlatformDir), "vendor"));
		expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBe(vendorDir);
	});

	it("is idempotent: a value it already wrote is not recomputed or replaced", () => {
		const first = makeConsumer(join(root, "first"));
		const second = makeConsumer(join(root, "second"));
		writePlatformPackage(first.hoistedPlatformDir);
		writePlatformPackage(second.hoistedPlatformDir);

		const written = ensureCursorTreeSitterVendorDir(first.moduleUrl);
		expect(ensureCursorTreeSitterVendorDir(second.moduleUrl)).toBeUndefined();

		expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBe(written);
	});

	it("leaves an absolute explicit value untouched even when the package has both parsers", () => {
		const consumer = makeConsumer(root);
		writePlatformPackage(consumer.hoistedPlatformDir);
		process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV] = "/explicit/vendor";

		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBeUndefined();

		expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBe("/explicit/vendor");
	});

	// The SDK takes the variable only when it is absolute (locked below), so an empty or relative value
	// leaves shell analysis off; ensureCursorRipgrepPath treats CURSOR_RIPGREP_PATH the same way.
	for (const ignoredBySdk of ["relative/vendor", ""]) {
		it(`replaces the value ${JSON.stringify(ignoredBySdk)}, which the SDK ignores, when the package has both parsers`, () => {
			const consumer = makeConsumer(root);
			writePlatformPackage(consumer.hoistedPlatformDir);
			process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV] = ignoredBySdk;

			const vendorDir = ensureCursorTreeSitterVendorDir(consumer.moduleUrl);

			expect(vendorDir).toBe(join(realpathSync(consumer.hoistedPlatformDir), "vendor"));
			expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBe(vendorDir);
		});

		it(`keeps the value ${JSON.stringify(ignoredBySdk)} when no package has both parsers`, () => {
			const consumer = makeConsumer(root);
			writePlatformPackage(consumer.hoistedPlatformDir, ["tree-sitter"]);
			process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV] = ignoredBySdk;

			expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBeUndefined();

			expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBe(ignoredBySdk);
		});
	}

	it("remembers a miss for the process: a package installed after the first probe is not looked for again", () => {
		const consumer = makeConsumer(root);
		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBeUndefined();

		// The probe would now succeed; the remembered miss is what keeps every later SDK load from
		// re-running the module resolution and the filesystem walk.
		writePlatformPackage(consumer.hoistedPlatformDir);
		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBeUndefined();
		expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBeUndefined();

		// The miss belongs to the module that was probed, not to the process as a whole.
		const other = makeConsumer(join(root, "other"));
		writePlatformPackage(other.hoistedPlatformDir);
		expect(ensureCursorTreeSitterVendorDir(other.moduleUrl)).toBe(join(realpathSync(other.hoistedPlatformDir), "vendor"));
	});

	for (const present of [["tree-sitter"], ["tree-sitter-bash"], []]) {
		it(`does not set the variable unless both parser entrypoints exist (index.js present for ${JSON.stringify(present)})`, () => {
			const consumer = makeConsumer(root);
			writePlatformPackage(consumer.hoistedPlatformDir, present);

			expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBeUndefined();

			expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBeUndefined();
		});
	}

	it("does not set the variable when no platform package is installed", () => {
		const consumer = makeConsumer(root);

		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBeUndefined();

		expect(process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV]).toBeUndefined();
	});

	it("skips a nested package that lacks the parsers for the hoisted one that has them", () => {
		const consumer = makeConsumer(root);
		writePlatformPackage(consumer.nestedPlatformDir, ["tree-sitter"]);
		writePlatformPackage(consumer.hoistedPlatformDir);

		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBe(
			join(realpathSync(consumer.hoistedPlatformDir), "vendor"),
		);
	});

	it("prefers the package nested under @cursor/sdk when both have the parsers", () => {
		const consumer = makeConsumer(root);
		writePlatformPackage(consumer.nestedPlatformDir);
		writePlatformPackage(consumer.hoistedPlatformDir);

		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBe(
			join(realpathSync(consumer.nestedPlatformDir), "vendor"),
		);
	});
});

describe("platform package resolution shared with ripgrep", () => {
	it("judges each caller by the files it reads, so neither is derailed by a package that lacks the other's", () => {
		const consumer = makeConsumer(root);
		// The nested package has the parsers but no ripgrep; the hoisted one has ripgrep but no parsers.
		writePlatformPackage(consumer.nestedPlatformDir);
		writePlatformPackage(consumer.hoistedPlatformDir, []);
		const hoistedRipgrep = writeRipgrep(consumer.hoistedPlatformDir);

		expect(resolveBundledCursorRipgrepPath(consumer.moduleUrl)).toBe(realpathSync(hoistedRipgrep));
		expect(ensureCursorTreeSitterVendorDir(consumer.moduleUrl)).toBe(
			join(realpathSync(consumer.nestedPlatformDir), "vendor"),
		);
	});
});

describe("installed @cursor/sdk native parser lookup", () => {
	function countOf(text: string, anchor: string): number {
		return text.split(anchor).length - 1;
	}

	function loadedParserPackageNames(text: string): string[] {
		return [...text.matchAll(/packageName:"([^"]+)",nativeRequire/g)].map((match) => match[1]!);
	}

	// The SDK's vendored loader (`vendored-tree-sitter.ts`): an absolute CURSOR_TREE_SITTER_VENDOR_DIR is
	// taken as the vendor directory without checking it, anything else falls back to the SDK's own
	// ancestor search, and the parser is then required from `<vendor>/<packageName>/index.js`. That is
	// why the variable may only point at a vendor directory that has both parsers' entrypoints, and
	// why an empty or relative value counts as unset.
	const ENV_READ = "process\\.env\\.CURSOR_TREE_SITTER_VENDOR_DIR";

	it.each(["esm", "cjs"] as const)(
		"dist/%s (the build Node loads) honors an absolute vendor dir and joins <vendor>/<packageName>/index.js",
		(build) => {
			const bundle = readCursorSdkBuildSource(build);

			const envRead = onlyMatch(
				bundle,
				`const (${IDENT})=${ENV_READ};return \\1&&\\(0,(${IDENT})\\.isAbsolute\\)\\(\\1\\)\\?\\1:\\(0,${IDENT}\\.${IDENT}\\)\\(\\{relativePath:"vendor",`,
				"the variable is taken only when it is absolute, else the SDK's own search runs",
			);
			const parserRequire = onlyMatch(
				bundle,
				`\\{available:!0,module:${IDENT}\\.nativeRequire\\(\\(0,(${IDENT})\\.join\\)\\(${IDENT},${IDENT}\\.packageName,"index\\.js"\\)\\)\\}`,
				"the parser is required from <vendor>/<packageName>/index.js",
			);
			// `isAbsolute` and `join` are the members of node:path, not of some other module.
			for (const alias of new Set([envRead[2]!, parserRequire[1]!])) {
				expect(bundle, `${alias} is node:path`).toMatch(new RegExp(`${escapeRegExp(alias)}=${IDENT}\\("node:path"\\)`));
			}
			expect(countOf(bundle, "process.env.CURSOR_TREE_SITTER_VENDOR_DIR"), "single read of the variable").toBe(1);
		},
	);

	it("dist/bundled/index.js (the build Bun, and so omp, imports) honors an absolute vendor dir and joins <vendor>/<packageName>/index.js", () => {
		const bundle = readCursorSdkBuildSource("bundled");

		const envRead = onlyMatch(
			bundle,
			`let (${IDENT})=${ENV_READ};if\\(\\1&&(${IDENT})\\(\\1\\)\\)return \\1;return ${IDENT}\\(\\{relativePath:"vendor",`,
			"the variable is taken only when it is absolute, else the SDK's own search runs",
		);
		const parserRequire = onlyMatch(
			bundle,
			`\\{available:!0,module:${IDENT}\\.nativeRequire\\((${IDENT})\\(${IDENT},${IDENT}\\.packageName,"index\\.js"\\)\\)\\}`,
			"the parser is required from <vendor>/<packageName>/index.js",
		);
		// The local names are `isAbsolute` and `join` imported from "path", not some other function.
		const pathMembers = { isAbsolute: envRead[2]!, join: parserRequire[1]! };
		for (const [member, alias] of Object.entries(pathMembers)) {
			expect(bundle, `${alias} is path.${member}`).toMatch(
				new RegExp(`import\\{(?:[^}]*,)?${member} as ${escapeRegExp(alias)}(?:,[^}]*)?\\}from"path"`),
			);
		}
		expect(countOf(bundle, "process.env.CURSOR_TREE_SITTER_VENDOR_DIR"), "single read of the variable").toBe(1);
	});

	it("loads exactly the parser packages ensureCursorTreeSitterVendorDir requires entrypoints for", () => {
		const expected = [...CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES].sort();

		for (const build of CURSOR_SDK_BUILDS) {
			expect(loadedParserPackageNames(readCursorSdkBuildSource(build)).sort(), build).toEqual(expected);
		}
	});

	it.skipIf(installedPlatformPackageDir === undefined)(
		"the installed platform package has the entrypoint of every parser the SDK loads",
		() => {
			for (const name of CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES) {
				const entrypoint = join(installedPlatformPackageDir!, "vendor", name, "index.js");
				expect(existsSync(entrypoint), entrypoint).toBe(true);
			}
		},
	);
});

interface ObservedAtSdkEvaluation {
	observedVendorDir: string | null;
	outputFilterAtImport: boolean;
	outputFilterAtEvaluation: boolean;
	outputFilterAfterLoad: boolean;
}

function runFirstLoadChild<T>(mode: string, vendorDirEnv: string | undefined): T {
	const env = { ...process.env };
	if (vendorDirEnv === undefined) delete env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV];
	else env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV] = vendorDirEnv;
	const result = spawnSync(process.execPath, [firstLoadChildScript, mode], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(result.status, `${result.stderr}`).toBe(0);
	const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
	if (!line) throw new Error(`The child printed no result:\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(line.slice("RESULT:".length)) as T;
}

// The observer child replaces @cursor/sdk, so this needs no installed platform package.
describe("first SDK load output filter lease", () => {
	it("the first loadCursorSdk takes the process output filter lease before @cursor/sdk is evaluated, and importing the loader does not", () => {
		const observed = runFirstLoadChild<ObservedAtSdkEvaluation>("observe-sdk-evaluation", undefined);

		expect(observed.outputFilterAtImport).toBe(false);
		expect(observed.outputFilterAtEvaluation).toBe(true);
		expect(observed.outputFilterAfterLoad).toBe(true);
	});
});

describe.skipIf(installedPlatformPackageDir === undefined)("first SDK load in a fresh process", () => {
	interface NativeBashParsing {
		before: boolean[];
		after: boolean[];
		root?: { type: string; hasError: boolean; tree: string };
	}

	it("loadCursorSdk sets the variable before @cursor/sdk is first evaluated", () => {
		const { observedVendorDir } = runFirstLoadChild<ObservedAtSdkEvaluation>("observe-sdk-evaluation", undefined);

		if (observedVendorDir === null) throw new Error("@cursor/sdk was evaluated with the variable unset");
		expect(realpathSync(observedVendorDir)).toBe(realpathSync(join(installedPlatformPackageDir!, "vendor")));
	});

	it("loadCursorSdk leaves an absolute explicit value alone when @cursor/sdk is first evaluated", () => {
		const { observedVendorDir } = runFirstLoadChild<ObservedAtSdkEvaluation>("observe-sdk-evaluation", "/explicit/vendor");

		expect(observedVendorDir).toBe("/explicit/vendor");
	});

	it("loadCursorSdk replaces a relative value, which the SDK would ignore, before @cursor/sdk is first evaluated", () => {
		const { observedVendorDir } = runFirstLoadChild<ObservedAtSdkEvaluation>("observe-sdk-evaluation", "relative/vendor");

		if (observedVendorDir === null) throw new Error("@cursor/sdk was evaluated with the variable unset");
		expect(realpathSync(observedVendorDir)).toBe(realpathSync(join(installedPlatformPackageDir!, "vendor")));
	});

	it("enables the SDK's real native Bash parser when launched from where its own lookup cannot reach", () => {
		const result = runFirstLoadChild<NativeBashParsing>("native-bash-parsing", undefined);

		// Without the variable the SDK's search of argv[1] and execPath ancestors finds nothing: the
		// compiled omp binary and a plugin installed beside it are in neither chain.
		expect(result.before).toEqual([false, false]);
		expect(result.after).toEqual([true, true]);
		expect(result.root).toMatchObject({ type: "program", hasError: false });
		expect(result.root?.tree).toContain("pipeline");
	}, 60_000);
});
