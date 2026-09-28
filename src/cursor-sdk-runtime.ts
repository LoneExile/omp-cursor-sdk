import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CursorSdkModule = typeof import("@cursor/sdk");

export async function loadCursorSdk(): Promise<CursorSdkModule> {
	return import("@cursor/sdk");
}

/**
 * Locate the `@cursor/sdk` package directory a module of this package resolves `@cursor/sdk` to.
 *
 * A Bun single-file compiled binary (the shipping `omp`) resolves a bare specifier for an on-disk
 * extension file against its embedded `$bunfs` root, so `import.meta.resolve` and
 * `createRequire(...).resolve` throw there even though the real import resolves normally. Walk the
 * `node_modules` chain by hand instead: that is the chain the runtime import resolves against.
 */
export function findCursorSdkPackageDir(moduleUrl: string | URL): string | undefined {
	let dir: string;
	try {
		dir = dirname(fileURLToPath(moduleUrl));
	} catch {
		// Not a file URL: treat the input as a filesystem path.
		dir = dirname(String(moduleUrl));
	}
	for (;;) {
		const packageDir = join(dir, "node_modules", "@cursor", "sdk");
		if (existsSync(join(packageDir, "package.json"))) return packageDir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
