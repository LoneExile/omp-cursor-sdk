import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TARGETS } from "../scripts/patch-cursor-sdk.mjs";
import { CURSOR_SDK_BUILDS, CURSOR_SDK_ROOT, readCursorSdkBuildSource } from "./helpers/cursor-sdk-build-source.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(TEST_DIR, "../scripts/patch-cursor-sdk.mjs");
const COMMIT_ATTRIBUTION_MARKER = "/* omp-cursor-sdk:commit-attribution-patch */";
const COMMIT_ATTRIBUTION_ANCHOR = "attributeCommitsToAgent??!0";
const COMMIT_ATTRIBUTION_PATCHED = `attributeCommitsToAgent??!1${COMMIT_ATTRIBUTION_MARKER}`;
const PR_ATTRIBUTION_DEFAULT = "attributePRsToAgent??!0";

// The two shapes the SDK writes the local executor's attribution default in: webpack + terser for
// esm/cjs, esbuild for the bundled build. Only the anchor and the property names are stable.
const WEBPACK_CHUNK = `O=this.attributionConfigProvider?.get(),N=!S&&(O?.attribution?.${COMMIT_ATTRIBUTION_ANCHOR}),$=!S&&(O?.attribution?.${PR_ATTRIBUTION_DEFAULT}),F=1`;
const BUNDLED_CHUNK = `let m=this.attributionConfigProvider?.get();let u=A?!1:m?.attribution?.${COMMIT_ATTRIBUTION_ANCHOR};let p=A?!1:m?.attribution?.${PR_ATTRIBUTION_DEFAULT};let e=1`;

// Chunk names differ per build on purpose: the anchor is found by content, never by file name.
const FIXTURES = {
	"dist/esm/index.js": "export const entry = 1;",
	"dist/esm/331.js": WEBPACK_CHUNK,
	"dist/esm/native/extra.js": "export const unrelated = 2;",
	"dist/cjs/index.js": "module.exports = 1;",
	"dist/cjs/9999.js": WEBPACK_CHUNK,
	"dist/bundled/index.js": BUNDLED_CHUNK,
} as const;
const ANCHOR_FILES = ["dist/esm/331.js", "dist/cjs/9999.js", "dist/bundled/index.js"] as const;

function writeFixture(root: string, files: Record<string, string> = FIXTURES): void {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
}

function runPatch(args: string[]) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function countOf(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function filesUnder(directory: string, suffix: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return filesUnder(path, suffix);
		return entry.name.endsWith(suffix) ? [path] : [];
	});
}

// The script's shebang and every documented command run it under Node, and only Node leaves symlinks
// in process.argv[1] while resolving them in import.meta.url (Bun resolves both).
const nodeAvailable = spawnSync("node", ["--version"], { stdio: "ignore" }).status === 0;

describe("patch-cursor-sdk", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	function tempSdk(): string {
		const root = mkdtempSync(join(tmpdir(), "patch-cursor-sdk-"));
		roots.push(root);
		return root;
	}

	it("targets the three builds the SDK ships, one patch each", () => {
		expect(TARGETS.map((target) => target.build)).toEqual(["dist/esm", "dist/cjs", "dist/bundled"]);
		for (const target of TARGETS) {
			expect(target.from).toBe(COMMIT_ATTRIBUTION_ANCHOR);
			expect(target.to).toBe(COMMIT_ATTRIBUTION_PATCHED);
			expect(target.marker).toBe(COMMIT_ATTRIBUTION_MARKER);
		}
	});

	it("patches the file that holds the anchor in every build whatever its name, is idempotent, and --check reports drift", () => {
		const root = tempSdk();
		writeFixture(root);

		const before = runPatch(["--check", "--sdk", root]);
		expect(before.status).not.toBe(0);
		for (const file of ANCHOR_FILES) expect(before.stdout, file).toContain(`${file}: unpatched`);

		const patched = runPatch(["--sdk", root]);
		expect(patched.status).toBe(0);
		for (const file of ANCHOR_FILES) expect(patched.stdout, file).toContain(`${file}: patched`);
		const afterPatch = Object.fromEntries(Object.keys(FIXTURES).map((rel) => [rel, readFileSync(join(root, rel), "utf8")]));
		for (const file of ANCHOR_FILES) {
			const text = afterPatch[file] ?? "";
			expect(countOf(text, COMMIT_ATTRIBUTION_PATCHED), file).toBe(1);
			expect(countOf(text, COMMIT_ATTRIBUTION_MARKER), file).toBe(1);
			expect(text, file).not.toContain(COMMIT_ATTRIBUTION_ANCHOR);
			// Only the commit trailer default changes; the PR attribution default is left alone.
			expect(text, file).toContain(PR_ATTRIBUTION_DEFAULT);
		}
		// Files without the anchor are not touched.
		for (const rel of ["dist/esm/index.js", "dist/esm/native/extra.js", "dist/cjs/index.js"] as const) {
			expect(afterPatch[rel], rel).toBe(FIXTURES[rel]);
		}

		expect(runPatch(["--sdk", root]).status).toBe(0);
		for (const rel of Object.keys(FIXTURES)) expect(readFileSync(join(root, rel), "utf8"), rel).toBe(afterPatch[rel]);

		const checked = runPatch(["--check", "--sdk", root]);
		expect(checked.status).toBe(0);
		for (const file of ANCHOR_FILES) expect(checked.stdout, file).toContain(`${file}: patched`);

		writeFileSync(join(root, "dist/cjs/9999.js"), `drifted ${COMMIT_ATTRIBUTION_MARKER} but not the expression`);
		const drifted = runPatch(["--check", "--sdk", root]);
		expect(drifted.status).not.toBe(0);
		expect(drifted.stderr).toContain("dist/cjs/9999.js");
		expect(drifted.stdout).toContain("dist/cjs: drifted");
	});

	it("fails loudly when an existing build has no file with the anchor, and writes nothing there", () => {
		const root = tempSdk();
		writeFixture(root, { ...FIXTURES, "dist/esm/331.js": "no attribution default here" });
		const result = runPatch(["--sdk", root]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("dist/esm");
		expect(result.stderr).toContain(COMMIT_ATTRIBUTION_ANCHOR);
		expect(readFileSync(join(root, "dist/esm/331.js"), "utf8")).toBe("no attribution default here");
		// The builds that do have it are still patched.
		expect(readFileSync(join(root, "dist/bundled/index.js"), "utf8")).toContain(COMMIT_ATTRIBUTION_MARKER);
	});

	it("fails loudly when the anchor appears in more than one file of a build, and patches neither", () => {
		const root = tempSdk();
		writeFixture(root, { ...FIXTURES, "dist/esm/duplicate.js": WEBPACK_CHUNK });
		const result = runPatch(["--sdk", root]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("dist/esm/331.js");
		expect(result.stderr).toContain("dist/esm/duplicate.js");
		expect(readFileSync(join(root, "dist/esm/331.js"), "utf8")).toBe(WEBPACK_CHUNK);
		expect(readFileSync(join(root, "dist/esm/duplicate.js"), "utf8")).toBe(WEBPACK_CHUNK);
	});

	it("patches repeated --sdk roots and does not require absent builds", () => {
		const first = tempSdk();
		const second = tempSdk();
		writeFixture(first, { "dist/bundled/index.js": BUNDLED_CHUNK });
		writeFixture(second, { "dist/esm/331.js": WEBPACK_CHUNK });
		const result = runPatch(["--sdk", first, "--sdk", second]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("dist/cjs: absent");
		expect(readFileSync(join(first, "dist/bundled/index.js"), "utf8")).toContain(COMMIT_ATTRIBUTION_MARKER);
		expect(readFileSync(join(second, "dist/esm/331.js"), "utf8")).toContain(COMMIT_ATTRIBUTION_MARKER);
		expect(runPatch(["--check", "--sdk", first, "--sdk", second]).status).toBe(0);
	});

	it("fails when the SDK root has no build directory at all", () => {
		const root = tempSdk();
		const result = runPatch(["--sdk", root]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("has none of dist/esm, dist/cjs, dist/bundled");
	});

	// macOS /tmp is a symlink, so a script path under it reaches Node as a symlinked path.
	function runThroughSymlink(nodeFlags: string[]): void {
		const root = tempSdk();
		writeFixture(root);
		const linkParent = tempSdk();
		const scriptsLink = join(linkParent, "scripts-link");
		symlinkSync(dirname(SCRIPT), scriptsLink);
		const viaLink = (args: string[]) =>
			spawnSync("node", [...nodeFlags, join(scriptsLink, "patch-cursor-sdk.mjs"), ...args], { encoding: "utf8" });

		const before = viaLink(["--check", "--sdk", root]);
		expect(before.stdout).toContain("unpatched");
		expect(before.status).toBe(1);

		expect(viaLink(["--sdk", root]).status).toBe(0);
		expect(readFileSync(join(root, "dist/bundled/index.js"), "utf8")).toContain(COMMIT_ATTRIBUTION_MARKER);
		expect(viaLink(["--check", "--sdk", root]).status).toBe(0);
	}

	it.skipIf(!nodeAvailable)("runs, instead of silently doing nothing, when Node starts it through a symlinked path", () => {
		runThroughSymlink([]);
	});

	it.skipIf(!nodeAvailable)("runs through a symlinked path under --preserve-symlinks-main too", () => {
		runThroughSymlink(["--preserve-symlinks-main"]);
	});

	// Copies only the SDK's `.js` files: the script writes into whatever root it is given, and the
	// installed package under node_modules must not be patched or unpatched by the suite.
	function copyOfInstalledSdk(): string {
		const root = tempSdk();
		for (const build of CURSOR_SDK_BUILDS) {
			cpSync(join(CURSOR_SDK_ROOT, "dist", build), join(root, "dist", build), {
				recursive: true,
				filter: (source) => statSync(source).isDirectory() || source.endsWith(".js"),
			});
		}
		return root;
	}

	it("finds, patches, and re-checks the anchor in the real installed SDK layout", () => {
		const root = copyOfInstalledSdk();
		// Start from the unpatched shape whatever state the installed package is in.
		for (const path of filesUnder(join(root, "dist"), ".js")) {
			const text = readFileSync(path, "utf8");
			if (text.includes(COMMIT_ATTRIBUTION_PATCHED)) writeFileSync(path, text.replace(COMMIT_ATTRIBUTION_PATCHED, () => COMMIT_ATTRIBUTION_ANCHOR));
		}
		const before = runPatch(["--check", "--sdk", root]);
		expect(before.stderr).toBe("");
		expect(before.status).toBe(1);
		for (const target of TARGETS) expect(before.stdout, target.build).toMatch(new RegExp(`${target.build}/[^\\s:]+: unpatched`));

		const patched = runPatch(["--sdk", root]);
		expect(patched.stderr).toBe("");
		expect(patched.status).toBe(0);
		const after = runPatch(["--check", "--sdk", root]);
		expect(after.stderr).toBe("");
		expect(after.status).toBe(0);
		for (const target of TARGETS) expect(after.stdout, target.build).toMatch(new RegExp(`${target.build}/[^\\s:]+: patched`));
	});
});

describe("installed Cursor SDK commit attribution", () => {
	for (const build of CURSOR_SDK_BUILDS) {
		it(`has exactly one attribution default in the ${build} build, read from the attribution provider`, () => {
			const source = readCursorSdkBuildSource(build);
			expect(countOf(source, COMMIT_ATTRIBUTION_ANCHOR) + countOf(source, COMMIT_ATTRIBUTION_PATCHED), build).toBe(1);
			const providerDefault =
				/this\.attributionConfigProvider\?\.get\(\)[,;][^]{0,80}?[\w$]+\?\.attribution\?\.attributeCommitsToAgent\?\?!(?:0|1\/\* omp-cursor-sdk:commit-attribution-patch \*\/)/g;
			expect([...source.matchAll(providerDefault)], build).toHaveLength(1);
		});
	}

	it("exposes no public attribution control, so the patch is still the only way to turn the trailer off", () => {
		const declarations = filesUnder(join(CURSOR_SDK_ROOT, "dist", "esm"), ".d.ts");
		expect(declarations.length).toBeGreaterThan(0);
		for (const path of declarations) expect(readFileSync(path, "utf8"), path).not.toMatch(/attribution/i);
	});

	it("turns the missing attribution provider into commit attribution off, and keeps an explicit value", () => {
		const evaluate = (expression: string, provider: unknown) =>
			new Function("provider", `const E = provider; return E?.attribution?.${expression}`)(provider) as boolean;
		for (const target of TARGETS) {
			expect(evaluate(target.to, undefined), target.build).toBe(false);
			expect(evaluate(target.to, {}), target.build).toBe(false);
			expect(evaluate(target.to, { attribution: {} }), target.build).toBe(false);
			expect(evaluate(target.to, { attribution: { attributeCommitsToAgent: false } }), target.build).toBe(false);
			expect(evaluate(target.to, { attribution: { attributeCommitsToAgent: true } }), target.build).toBe(true);
		}
	});
});
