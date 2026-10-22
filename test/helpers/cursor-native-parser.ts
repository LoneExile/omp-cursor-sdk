import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

/** The result the SDK's vendored loader returns for one native package. */
export type InstalledCursorParserLoad =
	| { available: false; reason: string }
	| { available: true; module: unknown };

type WebpackFactory = (module: object, exports: object, webpackRequire: WebpackRequire) => void;
type WebpackRequire = ((name: string) => unknown) & {
	r: () => void;
	d: (target: object, getters: Record<string, () => unknown>) => void;
};
type VendorLoader = {
	loadVendoredTreeSitterModule(options: {
		packageName: string;
		nativeRequire: NodeJS.Require;
	}): InstalledCursorParserLoad;
};

/** The ESM entry of the installed `@cursor/sdk`, whose loader text `loadInstalledCursorParsers` runs. */
export function installedCursorSdkEsmEntry(fromModuleUrl: string): string {
	const sdkEntry = createRequire(fromModuleUrl).resolve("@cursor/sdk");
	// Resolves to dist/{bundled,cjs,esm}/index.js; the loader text under test is the ESM build's.
	return join(dirname(sdkEntry), "..", "esm", "index.js");
}

/**
 * Run the installed SDK's own vendored tree-sitter loader (`vendored-tree-sitter.ts` and the
 * `platform-package-locator.ts` it calls, copied verbatim out of `dist/esm/index.js`) against the real
 * `process`, so what it reports is what the SDK would find for the current env, `argv[1]` and
 * `execPath`. It is not a reimplementation of the SDK's lookup. Returns the `tree-sitter` and
 * `tree-sitter-bash` load results, in that order.
 */
export function loadInstalledCursorParsers(sdkEsmEntry: string): InstalledCursorParserLoad[] {
	const require = createRequire(sdkEsmEntry);
	const source = readFileSync(sdkEsmEntry, "utf8");
	const names = ["./src/agent/native/vendored-tree-sitter.ts", "./src/agent/platform-package-locator.ts"];
	const end = source.indexOf(',"./src/agent/run-interaction-accumulator.ts"(');
	const start = source.indexOf(`"${names[0]}"(`);
	if (start < 0 || end <= start) throw new Error("Installed SDK vendor loader contract changed");
	const factories: Record<string, WebpackFactory> = runInNewContext(`({${source.slice(start, end)}})`, { process });
	const cache: Record<string, object> = {};
	const webpackRequire: WebpackRequire = Object.assign(
		(name: string): unknown => {
			if (name.startsWith("node:")) return require(name);
			if (!cache[name]) {
				cache[name] = {};
				factories[name]!({}, cache[name], webpackRequire);
			}
			return cache[name];
		},
		{
			r: () => {},
			d: (target: object, getters: Record<string, () => unknown>) => {
				for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
			},
		},
	);
	const vendor = webpackRequire(names[0]) as VendorLoader;
	return ["tree-sitter", "tree-sitter-bash"].map((packageName) =>
		vendor.loadVendoredTreeSitterModule({ packageName, nativeRequire: require }),
	);
}
