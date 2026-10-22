import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CURSOR_SDK_ROOT, readCursorSdkEntrySource } from "./cursor-sdk-build-source.js";

/**
 * The lazy module initializer (`var <init>=<lazy>(()=>{`, esbuild's wrapper around a module body) whose body
 * holds the code at `index`, or `undefined` when that code is at the top level. The wrapper opens within a few
 * hundred characters of the first declaration it holds, so only that window is searched.
 */
export function lazyInitializerBefore(source: string, index: number): string | undefined {
	const window = source.slice(Math.max(0, index - 2000), index);
	const openings = [...window.matchAll(/var ([\w$]+)=[\w$]+\(\(\)=>\{/g)];
	return openings.at(-1)?.[1];
}

export interface InstalledBundledSdkInternals<T> {
	/** What `exportsSource` evaluated to, from the SDK's own code. */
	internals: T;
	dispose(): void;
}

/**
 * Loads a second copy of the installed bundled SDK that also exports `exportsSource` (a JavaScript expression
 * over the bundle's own minified top-level names, which the caller discovers from the build's text) as
 * `__internals`. This is how a test runs classes and functions the SDK does not export, as Bun runs them. The
 * copy sits at `<tmp>/node_modules/@cursor/sdk/dist/bundled/index.js`, so its stack frames carry the SDK's path, and
 * resolves the SDK's own dependencies through a link to the installed `node_modules`. Nothing is written under
 * the installed package.
 */
export async function loadInstalledBundledSdkInternals<T>(exportsSource: string): Promise<InstalledBundledSdkInternals<T>> {
	// Resolved through links, so the copy finds the SDK's own dependencies beside the real package, as node_modules layouts that link packages need.
	const sdkRoot = realpathSync(CURSOR_SDK_ROOT);
	const root = mkdtempSync(join(realpathSync(tmpdir()), "omp-cursor-sdk-internals-"));
	try {
		const copyRoot = join(root, "node_modules", "@cursor", "sdk");
		const entry = join(copyRoot, "dist", "bundled", "index.js");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(join(copyRoot, "package.json"), readFileSync(join(sdkRoot, "package.json")));
		writeFileSync(entry, `${readCursorSdkEntrySource("bundled")}\nexport const __internals = ${exportsSource};\n`);
		symlinkSync(dirname(dirname(sdkRoot)), join(copyRoot, "node_modules"), "junction");
		// A runtime-built specifier: the module is generated above, so a static import cannot name it.
		const loaded = (await import(pathToFileURL(entry).href)) as { __internals: T };
		return { internals: loaded.__internals, dispose: () => rmSync(root, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
