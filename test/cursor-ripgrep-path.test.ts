import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCursorRipgrepPath, resolveBundledCursorRipgrepPath } from "../src/cursor-ripgrep-path.js";
import { readCursorSdkEntrySource } from "./helpers/cursor-sdk-build-source.js";
import { escapeRegExp, IDENT, onlyMatch } from "./helpers/cursor-sdk-minified-source.js";
import { readInstalledPackageVersion } from "./helpers/installed-package.js";

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

	it("locks the installed @cursor/sdk ripgrep resolver that ensureCursorRipgrepPath feeds", () => {
		expect(readInstalledPackageVersion("@cursor/sdk")).toBe("1.0.40");
		// The build Bun, and so omp, imports.
		const bundle = readCursorSdkEntrySource("bundled");

		// The local runtime picks one ripgrep path: an absolute CURSOR_RIPGREP_PATH of any file name (a relative or
		// empty one counts as unset, so ensureCursorRipgrepPath only keeps an absolute value), else the `bin/rg`
		// (`bin/rg.exe` on Windows) of the @cursor/sdk-<platform>-<arch> package found from the entry script and the
		// executable, else `rg` from PATH. A platform package the SDK cannot find is what ensureCursorRipgrepPath
		// compensates for by writing the path it resolved into the variable.
		const resolverOrder = onlyMatch(
			bundle,
			`${IDENT}=process\\.platform==="win32"\\?"rg\\.exe":"rg",(${IDENT})=process\\.env\\.CURSOR_RIPGREP_PATH;` +
				`if\\(\\1&&(${IDENT})\\(\\1\\)\\)(${IDENT})=\\1;else \\3=(${IDENT})\\(\\{binaryName:${IDENT},excludedWorkspaceDir:${IDENT}\\}\\);` +
				`if\\(!\\3\\)\\3=${IDENT}\\(\\);if\\(\\3\\)${IDENT}\\(\\3\\);`,
			"an absolute CURSOR_RIPGREP_PATH wins, then the bundled search, then PATH",
		);
		expect(bundle, `${resolverOrder[2]} is path.isAbsolute`).toMatch(
			new RegExp(`import\\{(?:[^}]*,)?isAbsolute as ${escapeRegExp(resolverOrder[2]!)}(?:,[^}]*)?\\}from"path"`),
		);
		onlyMatch(
			bundle,
			`function ${escapeRegExp(resolverOrder[4]!)}\\((${IDENT})\\)\\{return ${IDENT}\\(\\{relativePath:${IDENT}\\("bin",\\1\\.binaryName\\),`,
			"the bundled search looks for bin/<binaryName>",
		);
		onlyMatch(
			bundle,
			`(${IDENT})=\`\\$\\{process\\.platform\\}-\\$\\{process\\.arch\\}\`,(${IDENT})=\\[\`@cursor/sdk-\\$\\{\\1\\}\`,\`@cursor/february-\\$\\{\\1\\}\`\\]`,
			"the bundled search walks node_modules/@cursor/sdk-<platform>-<arch> (or february-)",
		);
	});

	it("configures an empty path without overriding an existing absolute value", () => {
		process.env.CURSOR_RIPGREP_PATH = "";
		const bundledPath = ensureCursorRipgrepPath();
		expect(process.env.CURSOR_RIPGREP_PATH).toBe(bundledPath);

		process.env.CURSOR_RIPGREP_PATH = "/custom/rg";
		expect(ensureCursorRipgrepPath()).toBe("/custom/rg");
		expect(process.env.CURSOR_RIPGREP_PATH).toBe("/custom/rg");
	});
});
