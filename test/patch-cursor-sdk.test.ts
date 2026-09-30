import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TARGETS } from "../scripts/patch-cursor-sdk.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(TEST_DIR, "../scripts/patch-cursor-sdk.mjs");
const MARKER = "/* omp-cursor-sdk:max-mode-patch */";

const SDK_ROOT = join(TEST_DIR, "../node_modules/@cursor/sdk");
const INSTALLED_BUILD_FILES = TARGETS.filter((target) => existsSync(join(SDK_ROOT, target.rel)));

function evaluatePatchedCall(expression: string, model: { id: string; params: Array<{ id: string; value: string }> }) {
	const source = `
		const t = { model };
		const m = t;
		function ctor(value) { return value; }
		const nx = { G4: ctor, SR: ctor };
		const ax = nx;
		const r5 = ctor;
		const j$ = ctor;
		return ${expression};
	`;
	return new Function("model", source)(model) as { maxMode: boolean; parameters: Array<{ id: string; value: string }> };
}

const FIXTURES = {
	"dist/esm/479.js":
		"const m=void 0!==t.model?new nx.G4({modelId:t.model.id,parameters:(t.model.params??[]).map((e=>new nx.SR({id:e.id,value:e.value})))}):void 0;",
	"dist/cjs/479.js":
		"const m=void 0!==t.model?new ax.G4({modelId:t.model.id,parameters:(t.model.params??[]).map((e=>new ax.SR({id:e.id,value:e.value})))}):void 0;",
	"dist/bundled/index.js":
		"F0=m.model!==void 0?new r5({modelId:m.model.id,parameters:(m.model.params??[]).map((W1)=>new j$({id:W1.id,value:W1.value}))}):void 0,H0=",
} as const;

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

	it("patches every existing build file, is idempotent, and --check reports drift", () => {
		const root = tempSdk();
		writeFixture(root);

		const before = runPatch(["--check", "--sdk", root]);
		expect(before.status).not.toBe(0);
		expect(before.stdout + before.stderr).toContain("dist/esm/479.js");
		expect(before.stdout + before.stderr).toContain("unpatched");

		const patched = runPatch(["--sdk", root]);
		expect(patched.status).toBe(0);
		for (const target of TARGETS) {
			const text = readFileSync(join(root, target.rel), "utf8");
			expect(text).toContain(MARKER);
			expect(text).toContain("maxMode:");
			expect(text).toContain(".filter(");
			expect(text).not.toContain(target.from);
		}
		const esm = readFileSync(join(root, "dist/esm/479.js"), "utf8");
		expect(esm).toContain('.filter((e=>!(e.id==="max_mode"&&e.value==="true")))');
		expect(esm.split(MARKER).length - 1).toBe(1);

		const again = runPatch(["--sdk", root]);
		expect(again.status).toBe(0);
		expect(readFileSync(join(root, "dist/esm/479.js"), "utf8")).toBe(esm);

		const checked = runPatch(["--check", "--sdk", root]);
		expect(checked.status).toBe(0);
		expect(checked.stdout).toContain("dist/bundled/index.js");
		expect(checked.stdout).toContain("patched");

		writeFileSync(join(root, "dist/cjs/479.js"), `drifted ${MARKER} but not the expression`);
		const drifted = runPatch(["--check", "--sdk", root]);
		expect(drifted.status).not.toBe(0);
		expect(drifted.stderr).toContain("dist/cjs/479.js");
	});

	it("fails loudly when an existing build file has no patch anchor", () => {
		const root = tempSdk();
		writeFixture(root, { "dist/esm/479.js": "no model constructor here" });
		const result = runPatch(["--sdk", root]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("dist/esm/479.js");
		expect(readFileSync(join(root, "dist/esm/479.js"), "utf8")).toBe("no model constructor here");
	});

	it("patches repeated --sdk roots and does not require absent build files", () => {
		const first = tempSdk();
		const second = tempSdk();
		writeFixture(first, { "dist/bundled/index.js": FIXTURES["dist/bundled/index.js"] });
		writeFixture(second, { "dist/esm/479.js": FIXTURES["dist/esm/479.js"] });
		const result = runPatch(["--sdk", first, "--sdk", second]);
		expect(result.status).toBe(0);
		expect(readFileSync(join(first, "dist/bundled/index.js"), "utf8")).toContain(MARKER);
		expect(readFileSync(join(second, "dist/esm/479.js"), "utf8")).toContain(MARKER);
		expect(runPatch(["--check", "--sdk", first, "--sdk", second]).status).toBe(0);
	});
});

describe("installed Cursor SDK max-mode anchor", () => {
	it.skipIf(INSTALLED_BUILD_FILES.length === 0)("contains each build file's exact unpatched or patched constructor", () => {
		for (const target of INSTALLED_BUILD_FILES) {
			const text = readFileSync(join(SDK_ROOT, target.rel), "utf8");
			expect(text.includes(target.from) || text.includes(target.to), target.rel).toBe(true);
		}
	});

	it("evaluates the patch script's own call shape: maxMode on, sentinel dropped, other params kept", () => {
		const model = {
			id: "grok-4.7",
			params: [
				{ id: "context", value: "500k" },
				{ id: "max_mode", value: "true" },
				{ id: "fast", value: "true" },
			],
		};
		const plain = {
			id: "grok-4.7",
			params: [
				{ id: "context", value: "256k" },
				{ id: "fast", value: "false" },
			],
		};
		for (const target of TARGETS) {
			const enabled = evaluatePatchedCall(target.to, model);
			expect(enabled.maxMode, target.rel).toBe(true);
			expect(enabled.parameters.map((param) => param.id), target.rel).not.toContain("max_mode");
			expect(enabled.parameters, target.rel).toEqual([
				{ id: "context", value: "500k" },
				{ id: "fast", value: "true" },
			]);
			const disabled = evaluatePatchedCall(target.to, plain);
			expect(disabled.maxMode, target.rel).toBe(false);
			expect(disabled.parameters, target.rel).toEqual(plain.params);
		}
	});
});
