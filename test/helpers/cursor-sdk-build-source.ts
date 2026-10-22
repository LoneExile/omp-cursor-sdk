import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CURSOR_SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@cursor/sdk");

/** `bundled` is what Bun (omp's runtime) loads; Node loads `esm` (import) or `cjs` (require). */
export const CURSOR_SDK_BUILDS = ["bundled", "esm", "cjs"] as const;
export type CursorSdkBuild = (typeof CURSOR_SDK_BUILDS)[number];

export function cursorSdkBuildEntry(build: CursorSdkBuild): string {
	return join(CURSOR_SDK_ROOT, "dist", build, "index.js");
}

function listJsFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return listJsFiles(path);
		return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
	});
}

export interface CursorSdkBuildFile {
	/** Path inside the build's directory, `/`-separated (`index.js`, or a numbered chunk such as `331.js`). */
	name: string;
	source: string;
}

const files = new Map<CursorSdkBuild, readonly CursorSdkBuildFile[]>();
const sources = new Map<CursorSdkBuild, string>();

/**
 * Every `.js` file of one installed SDK build, as written (no rewriting), sorted by name and read once.
 *
 * This is the one enumerator of SDK build files: tests that need to know which chunk holds some code (the
 * esm and cjs builds are numbered chunks whose numbers change between SDK releases, the bundled build is one
 * `index.js`) locate it by content here and never by file name.
 */
export function readCursorSdkBuildFiles(build: CursorSdkBuild): readonly CursorSdkBuildFile[] {
	let result = files.get(build);
	if (result === undefined) {
		const directory = join(CURSOR_SDK_ROOT, "dist", build);
		result = listJsFiles(directory)
			.map((path) => ({ name: relative(directory, path).split(sep).join("/"), source: readFileSync(path, "utf8") }))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		files.set(build, result);
	}
	return result;
}

/** The build's `index.js` as written: the module a runtime loads first, and the whole bundled build under Bun. */
export function readCursorSdkEntrySource(build: CursorSdkBuild): string {
	const entry = readCursorSdkBuildFiles(build).find(({ name }) => name === "index.js");
	if (!entry) throw new Error(`installed @cursor/sdk ${build} build has no index.js`);
	return entry.source;
}

/**
 * Every `.js` file of one installed SDK build, joined into one string for pattern matching.
 *
 * Chunk file names and minified identifiers change between SDK releases, so contract tests match
 * patterns across the whole build with `[\w$]+` for identifiers. The builds also disagree on operand
 * order (the esm and cjs builds write `void 0!==x` and `!0===x`, the bundled build `x!==void 0` and
 * `x===!0`); both are rewritten to the second form here so one pattern covers all three builds.
 * Use `readCursorSdkBuildFiles` when the text must stay as written or the chunk matters.
 */
export function readCursorSdkBuildSource(build: CursorSdkBuild): string {
	let source = sources.get(build);
	if (source === undefined) {
		source = readCursorSdkBuildFiles(build)
			.map((file) => file.source)
			.join("\n")
			.replace(/void 0!==([\w$]+(?:\??\.[\w$]+)*)/g, "$1!==void 0")
			.replace(/!0===([\w$]+(?:\??\.[\w$]+)*)/g, "$1===!0");
		sources.set(build, source);
	}
	return source;
}
