import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureCursorRipgrepPath,
	isBundledCursorRipgrepPath,
	isCursorRipgrepBinary,
	resolveBundledCursorRipgrepPath,
} from "../src/cursor-ripgrep-path.js";

const originalRipgrepPath = process.env.CURSOR_RIPGREP_PATH;
const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
const rgBinaryName = process.platform === "win32" ? "rg.exe" : "rg";

afterEach(() => {
	if (originalRipgrepPath === undefined) delete process.env.CURSOR_RIPGREP_PATH;
	else process.env.CURSOR_RIPGREP_PATH = originalRipgrepPath;
});

describe("Cursor ripgrep path", () => {
	it("resolves the executable from the installed Cursor SDK platform package", () => {
		const ripgrepPath = resolveBundledCursorRipgrepPath();

		if (!ripgrepPath) throw new Error("Expected the installed Cursor SDK platform package to include ripgrep");
		expect(ripgrepPath.replaceAll("\\", "/")).toContain(platformPackage);
		expect(() => accessSync(ripgrepPath, constants.X_OK)).not.toThrow();
	});

	it("resolves a platform package nested under @cursor/sdk/node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-ripgrep-nested-"));
		try {
			const consumerDir = join(root, "consumer");
			const consumerModule = join(consumerDir, "index.js");
			const sdkDir = join(consumerDir, "node_modules", "@cursor", "sdk");
			const nestedPlatformDir = join(sdkDir, "node_modules", "@cursor", `sdk-${process.platform}-${process.arch}`);
			const nestedBinDir = join(nestedPlatformDir, "bin");
			const nestedRg = join(nestedBinDir, rgBinaryName);

			mkdirSync(nestedBinDir, { recursive: true });
			writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.23", main: "index.js" }));
			writeFileSync(join(sdkDir, "index.js"), "module.exports = {};\n");
			writeFileSync(
				join(nestedPlatformDir, "package.json"),
				JSON.stringify({ name: platformPackage, version: "1.0.23", bin: { rg: `bin/${rgBinaryName}` } }),
			);
			writeFileSync(nestedRg, "#!/bin/sh\nexit 0\n");
			chmodSync(nestedRg, 0o755);
			writeFileSync(consumerModule, "export {};\n");

			// Nested only — no hoisted platform package beside @cursor/sdk.
			const consumerRequire = createRequire(consumerModule);
			expect(() => consumerRequire.resolve(`${platformPackage}/package.json`)).toThrow();
			expect(consumerRequire.resolve("@cursor/sdk")).toBe(realpathSync(join(sdkDir, "index.js")));

			const resolved = resolveBundledCursorRipgrepPath(pathToFileURL(consumerModule));
			expect(resolved).toBe(realpathSync(nestedRg));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to the on-disk node_modules chain when the runtime cannot resolve the SDK", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-ripgrep-fallback-"));
		try {
			const consumerDir = join(root, "consumer");
			const consumerModule = join(consumerDir, "index.js");
			const sdkDir = join(consumerDir, "node_modules", "@cursor", "sdk");
			const platformDir = join(consumerDir, "node_modules", platformPackage);
			const platformBinDir = join(platformDir, "bin");
			const platformRg = join(platformBinDir, rgBinaryName);

			mkdirSync(platformBinDir, { recursive: true });
			mkdirSync(sdkDir, { recursive: true });
			// No entry point: require.resolve("@cursor/sdk") fails, as it does in a compiled binary.
			writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.32" }));
			writeFileSync(join(platformDir, "package.json"), JSON.stringify({ name: platformPackage, version: "1.0.32" }));
			writeFileSync(platformRg, "#!/bin/sh\nexit 0\n");
			chmodSync(platformRg, 0o755);
			writeFileSync(consumerModule, "export {};\n");

			expect(() => createRequire(consumerModule).resolve("@cursor/sdk")).toThrow();

			expect(resolveBundledCursorRipgrepPath(pathToFileURL(consumerModule))).toBe(realpathSync(platformRg));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("locks the installed @cursor/sdk 1.0.34 ripgrep resolver that isCursorRipgrepBinary mirrors", () => {
		const require = createRequire(import.meta.url);
		const sdkEntry = require.resolve("@cursor/sdk");
		const sdkRoot = join(dirname(sdkEntry), "..", "..");
		const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string };
		expect(sdkPackage.version).toBe("1.0.34");
		const bundle = readFileSync(join(sdkRoot, "dist", "bundled", "index.js"), "utf8");

		// The local runtime picks one ripgrep path and every unsandboxed ripgrep spawn uses it (`IZ`): an
		// absolute CURSOR_RIPGREP_PATH of any file name (`HO6` is path.isAbsolute), else the `bin/rg`
		// (`bin/rg.exe` on Windows) of the @cursor/sdk-<platform>-<arch> or @cursor/february-<platform>-<arch>
		// package found from the entry script and the executable (`ic0`), else `rg` from PATH.
		const anchors = {
			resolverOrder:
				'N=process.platform==="win32"?"rg.exe":"rg",O=process.env.CURSOR_RIPGREP_PATH;if(O&&HO6(O))B=O;else B=nc0({binaryName:N,excludedWorkspaceDir:q});if(!B)B=pP0();if(B)lP0(B);',
			envMustBeAbsolute: 'import{isAbsolute as HO6,resolve as GO6}from"path"',
			bundledBinary: 'function nc0($){return ic0({relativePath:lc0("bin",$.binaryName),excludedWorkspaceDirs:[$.excludedWorkspaceDir],accept:hT8}',
			bundledPackages: "Y=[`@cursor/sdk-${X}`,`@cursor/february-${X}`]",
			pathFallback: 'function pP0(){let $=O$("rg",[]).cmd;return $!=="rg"?$:void 0}',
			everySpawnUsesTheResolvedPath:
				'function IZ(){if(!HV)throw Error("Ripgrep path not configured. Call configureRipgrepPath() at startup.");return HV}',
			// A sandboxed run (any policy but insecure_none) goes to the sandbox helper instead of spawning ripgrep itself.
			sandboxedRunsUseTheHelper: 'if(X.type!=="insecure_none"){if(YE0())return uj1($,J,Z,X);',
		};
		for (const [fact, anchor] of Object.entries(anchors)) {
			expect(bundle.split(anchor).length - 1, fact).toBe(1);
		}
	});

	it("treats the configured absolute path, whatever its name, and any file named rg as Cursor's ripgrep", () => {
		const named = join(tmpdir(), "tools", "ripgrep-14");
		expect(isCursorRipgrepBinary(named, { CURSOR_RIPGREP_PATH: named })).toBe(true);
		expect(isCursorRipgrepBinary(join(tmpdir(), "tools", "other"), { CURSOR_RIPGREP_PATH: named })).toBe(false);
		expect(isCursorRipgrepBinary(join(tmpdir(), "bin", rgBinaryName), {})).toBe(true);
		expect(isCursorRipgrepBinary(join(tmpdir(), "bin", rgBinaryName), { CURSOR_RIPGREP_PATH: named })).toBe(true);
	});

	it("ignores a relative CURSOR_RIPGREP_PATH, as the SDK does, and does not take a shell for ripgrep", () => {
		expect(isCursorRipgrepBinary("ripgrep-14", { CURSOR_RIPGREP_PATH: "ripgrep-14" })).toBe(false);
		expect(isCursorRipgrepBinary(join(tmpdir(), "bin", "zsh"), { CURSOR_RIPGREP_PATH: "" })).toBe(false);
		expect(isCursorRipgrepBinary(join(tmpdir(), "bin", "rg-wrapper"), {})).toBe(false);
	});

	it("configures an empty path without overriding an existing absolute value", () => {
		process.env.CURSOR_RIPGREP_PATH = "";
		const bundledPath = ensureCursorRipgrepPath();
		expect(process.env.CURSOR_RIPGREP_PATH).toBe(bundledPath);

		process.env.CURSOR_RIPGREP_PATH = "/custom/rg";
		expect(ensureCursorRipgrepPath()).toBe("/custom/rg");
		expect(process.env.CURSOR_RIPGREP_PATH).toBe("/custom/rg");
	});

	it("recognizes the platform package's bin/rg by its path alone, whether or not the file exists", () => {
		const missing = join(tmpdir(), "gone", "node_modules", ...platformPackage.split("/"), "bin", rgBinaryName);
		expect(existsSync(missing)).toBe(false);
		expect(isBundledCursorRipgrepPath(missing)).toBe(true);
		expect(isBundledCursorRipgrepPath(join(tmpdir(), "bin", rgBinaryName))).toBe(false);
		expect(isBundledCursorRipgrepPath(join(tmpdir(), "node_modules", "@cursor", "sdk-other-arch", "bin", rgBinaryName))).toBe(false);
		expect(isBundledCursorRipgrepPath(join(tmpdir(), "node_modules", ...platformPackage.split("/"), "bin", "rg-wrapper"))).toBe(false);
	});

	it("recognizes the path ensureCursorRipgrepPath writes as the bundled ripgrep", () => {
		delete process.env.CURSOR_RIPGREP_PATH;
		const written = ensureCursorRipgrepPath();
		if (!written) throw new Error("Expected the installed Cursor SDK platform package to include ripgrep");
		expect(isBundledCursorRipgrepPath(written)).toBe(true);
	});
});
