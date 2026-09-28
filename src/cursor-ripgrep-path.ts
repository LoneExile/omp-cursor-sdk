import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { findCursorSdkPackageDir } from "./cursor-sdk-runtime.js";

const RIPGREP_ENV = "CURSOR_RIPGREP_PATH";

export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	const platformPackageDirName = `sdk-${process.platform}-${process.arch}`;
	const ripgrepBinaryName = process.platform === "win32" ? "rg.exe" : "rg";
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
	const configuredPath = process.env[RIPGREP_ENV];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;

	const bundledPath = resolveBundledCursorRipgrepPath();
	if (bundledPath) process.env[RIPGREP_ENV] = bundledPath;
	return bundledPath;
}
