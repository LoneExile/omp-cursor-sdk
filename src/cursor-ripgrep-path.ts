import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { findCursorSdkPackageDir } from "./cursor-sdk-package-dir.js";

export const CURSOR_RIPGREP_ENV = "CURSOR_RIPGREP_PATH";
export const CURSOR_TREE_SITTER_VENDOR_DIR_ENV = "CURSOR_TREE_SITTER_VENDOR_DIR";

const platformPackageDirName = `sdk-${process.platform}-${process.arch}`;
const ripgrepBinaryName = process.platform === "win32" ? "rg.exe" : "rg";
/**
 * The native parser packages the SDK loads, each from `<vendor>/<name>/index.js`, for shell command
 * analysis. `test/cursor-tree-sitter-vendor-dir.test.ts` locks this list against the installed SDK.
 */
export const CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES = ["tree-sitter", "tree-sitter-bash"] as const;

/**
 * The directory of the SDK's `@cursor/sdk-<platform>-<arch>` package that `isUsable` accepts, or
 * `undefined`. `isUsable` lets each caller require the files it reads (the ripgrep binary, the
 * vendored parsers), so a candidate that lacks them falls through to the next one instead of ending
 * the search.
 *
 * The runtime resolves the package from the SDK entry first. A Bun single-file compiled binary
 * cannot resolve a bare specifier from an extension file, so the on-disk `node_modules` chain the
 * SDK itself is imported from is the fallback.
 */
export function resolveCursorSdkPlatformPackageDirectory(
	isUsable: (packageDirectory: string) => boolean,
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	try {
		const require = createRequire(fromModuleUrl);
		const sdkEntry = require.resolve("@cursor/sdk");
		const packageDirectory = dirname(
			require.resolve(`@cursor/${platformPackageDirName}/package.json`, { paths: [dirname(sdkEntry)] }),
		);
		if (isUsable(packageDirectory)) return packageDirectory;
	} catch {
		// Resolution threw: use the on-disk chain below.
	}
	const sdkPackageDir = findCursorSdkPackageDir(fromModuleUrl);
	if (!sdkPackageDir) return undefined;

	const candidateDirectories = [
		join(sdkPackageDir, "node_modules", "@cursor", platformPackageDirName),
		join(dirname(sdkPackageDir), platformPackageDirName),
	];
	for (const candidateDirectory of candidateDirectories) {
		try {
			if (isUsable(candidateDirectory)) return realpathSync(candidateDirectory);
		} catch {
			// Try the next candidate directory.
		}
	}
	return undefined;
}

function hasExecutableRipgrep(packageDirectory: string): boolean {
	try {
		accessSync(join(packageDirectory, "bin", ripgrepBinaryName), constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveBundledCursorRipgrepPath(
	fromModuleUrl: string | URL = import.meta.url,
): string | undefined {
	const packageDirectory = resolveCursorSdkPlatformPackageDirectory(hasExecutableRipgrep, fromModuleUrl);
	return packageDirectory ? join(packageDirectory, "bin", ripgrepBinaryName) : undefined;
}

export function ensureCursorRipgrepPath(): string | undefined {
	const configuredPath = process.env[CURSOR_RIPGREP_ENV];
	if (configuredPath && isAbsolute(configuredPath)) return configuredPath;

	const bundledPath = resolveBundledCursorRipgrepPath();
	if (bundledPath) process.env[CURSOR_RIPGREP_ENV] = bundledPath;
	return bundledPath;
}

function hasTreeSitterVendor(packageDirectory: string): boolean {
	return CURSOR_TREE_SITTER_VENDOR_PACKAGE_NAMES.every((name) =>
		existsSync(join(packageDirectory, "vendor", name, "index.js")),
	);
}

/** Modules whose probe found no platform package with the vendored parsers; they are not probed again. */
const treeSitterVendorMisses = new Set<string>();

/**
 * Point the SDK's native shell parser at the installed platform package before the SDK first loads.
 *
 * The SDK (1.0.34) takes `CURSOR_TREE_SITTER_VENDOR_DIR` as the directory holding `tree-sitter/` and
 * `tree-sitter-bash/` only when it is an absolute path, and otherwise searches just the ancestors of
 * the entry script and of the executable for `node_modules/@cursor/sdk-<platform>-<arch>`. A plugin
 * installed beside a compiled `omp` binary is in neither chain, so the lookup misses and the SDK
 * disables shell command analysis.
 *
 * An absolute value is the user's and is never changed. An empty or relative value is one the SDK
 * ignores, so, as for `CURSOR_RIPGREP_PATH`, it counts as unset. The variable is set only when the
 * resolved platform package has both parser entrypoints. A miss is remembered for the process, so a
 * package that is not installed is probed once, not on every SDK load. Returns the directory it
 * wrote, or `undefined` when it wrote nothing.
 */
export function ensureCursorTreeSitterVendorDir(fromModuleUrl: string | URL = import.meta.url): string | undefined {
	const configuredDirectory = process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV];
	if (configuredDirectory && isAbsolute(configuredDirectory)) return undefined;

	const probeKey = String(fromModuleUrl);
	if (treeSitterVendorMisses.has(probeKey)) return undefined;
	const packageDirectory = resolveCursorSdkPlatformPackageDirectory(hasTreeSitterVendor, fromModuleUrl);
	if (!packageDirectory) {
		treeSitterVendorMisses.add(probeKey);
		return undefined;
	}

	const vendorDirectory = join(packageDirectory, "vendor");
	process.env[CURSOR_TREE_SITTER_VENDOR_DIR_ENV] = vendorDirectory;
	return vendorDirectory;
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
