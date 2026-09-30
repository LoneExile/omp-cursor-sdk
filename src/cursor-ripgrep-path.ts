import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { findCursorSdkPackageDir } from "./cursor-sdk-runtime.js";

export const CURSOR_RIPGREP_ENV = "CURSOR_RIPGREP_PATH";

const platformPackageDirName = `sdk-${process.platform}-${process.arch}`;
const ripgrepBinaryName = process.platform === "win32" ? "rg.exe" : "rg";

export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const require = createRequire(fromModuleUrl);
		const sdkEntry = require.resolve("@cursor/sdk");
		const packageDirectory = dirname(
			require.resolve(`@cursor/${platformPackageDirName}/package.json`, { paths: [dirname(sdkEntry)] }),
		);
		const ripgrepPath = join(packageDirectory, "bin", ripgrepBinaryName);
		accessSync(ripgrepPath, constants.X_OK);
		return ripgrepPath;
	} catch {
		// A Bun single-file compiled binary cannot resolve a bare specifier from an extension
		// file, so fall back to the on-disk chain the SDK itself is imported from.
	}
	const sdkPackageDir = findCursorSdkPackageDir(fromModuleUrl);
	if (!sdkPackageDir) return undefined;

	const candidateDirectories = [
		join(sdkPackageDir, "node_modules", "@cursor", platformPackageDirName),
		join(dirname(sdkPackageDir), platformPackageDirName),
	];
	for (const candidateDirectory of candidateDirectories) {
		const ripgrepPath = join(candidateDirectory, "bin", ripgrepBinaryName);
		try {
			accessSync(ripgrepPath, constants.X_OK);
			return realpathSync(ripgrepPath);
		} catch {
			// Try the next candidate directory.
		}
	}
	return undefined;
}

export function ensureCursorRipgrepPath(): string | undefined {
	const configuredPath = process.env[CURSOR_RIPGREP_ENV];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;

	const bundledPath = resolveBundledCursorRipgrepPath();
	if (bundledPath) process.env[CURSOR_RIPGREP_ENV] = bundledPath;
	return bundledPath;
}

/**
 * Whether `file` is the `bin/rg` of the SDK's platform package for this platform
 * (`@cursor/sdk-<platform>-<arch>`), the binary `ensureCursorRipgrepPath` writes into
 * `CURSOR_RIPGREP_PATH`. It reads the path only, so it also holds when that binary is missing or not
 * executable, the failures `resolveBundledCursorRipgrepPath` cannot name because it requires an
 * executable file.
 */
export function isBundledCursorRipgrepPath(file: string): boolean {
	const suffix = `/@cursor/${platformPackageDirName}/bin/${ripgrepBinaryName}`;
	const normalized = file.replaceAll("\\", "/");
	return (process.platform === "win32" ? normalized.toLowerCase() : normalized).endsWith(suffix);
}

/**
 * Whether `file` can be the ripgrep binary Cursor's local runtime spawns. The SDK (1.0.34, in its
 * local runtime bootstrap) picks one path and spawns it for every unsandboxed ripgrep run (a sandboxed
 * run spawns the SDK's sandbox helper and hands ripgrep to it as an argument): `CURSOR_RIPGREP_PATH`
 * when it is an absolute path, whatever the file is called; else the `bin/rg` (`bin/rg.exe` on
 * Windows) of the `@cursor/sdk-<platform>-<arch>` or `@cursor/february-<platform>-<arch>` package,
 * found by walking up from the entry script and from the executable; else `rg` from PATH. This
 * accepts the union of those: the configured absolute path, or any file named `rg` (`rg.exe` on
 * Windows). It does not model which one the SDK picked, so it can also accept an `rg` the SDK did not
 * pick; that only widens a check that also requires SDK stack provenance and a `spawn <file>` error.
 */
export function isCursorRipgrepBinary(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const configuredPath = env[CURSOR_RIPGREP_ENV];
	if (configuredPath && isAbsolute(configuredPath) && file === configuredPath) return true;
	return (process.platform === "win32" ? /^rg\.exe$/i : /^rg$/).test(basename(file));
}
