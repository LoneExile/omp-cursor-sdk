import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
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
 * The SDK (1.0.40) takes `CURSOR_TREE_SITTER_VENDOR_DIR` as the directory holding `tree-sitter/` and
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
