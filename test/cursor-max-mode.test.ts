import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelListItem, ModelSelection } from "@cursor/sdk";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_MAX_MODE_ENV, getCursorSdkUserConfigPath, resolveCursorMaxMode } from "../src/cursor-config.js";
import {
	applyCursorMaxModeSelection,
	assertCursorSdkMaxModePatched,
	CURSOR_MAX_MODE_PATCH_MARKER,
	CURSOR_MAX_MODE_PARAM,
	resolveImportedCursorSdkPath,
} from "../src/cursor-max-mode.js";
import {
	getEffectiveCursorMaxMode,
	registerCursorRuntimeControls,
	__testUtils,
} from "../src/cursor-state.js";
import { createDetachedCursorSessionBinding, runInCursorSessionBinding } from "../src/cursor-session-binding.js";
import { formatCursorStatus } from "../src/cursor-runtime-state.js";
import { buildCursorModelSelection, __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeModel,
} from "./helpers/pi-harness.js";

const UNPATCHED_ESM =
	'const m=void 0!==t.model?new x.G4({modelId:t.model.id,parameters:(null!==(u=t.model.params)&&void 0!==u?u:[]).map((e=>new x.SR({id:e.id,value:e.value})))}):void 0;';

const modelItems: ModelListItem[] = [
	{
		id: "grok-4.7",
		displayName: "Grok 4.7",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "256k" }, { value: "500k" }] },
			{ id: "reasoning_effort", displayName: "Reasoning", values: [{ value: "low" }, { value: "high" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "256k" },
					{ id: "reasoning_effort", value: "high" },
					{ id: "fast", value: "true" },
				],
				displayName: "Grok 4.7",
				isDefault: true,
			},
		],
	},
];

function writeSdkFixture(root: string, files: Record<string, string>): string {
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "1.0.32" }));
	return join(root, "dist/bundled/index.js");
}

describe("Cursor Max Mode selection", () => {
	beforeEach(() => {
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	it("leaves a disabled selection unchanged", () => {
		const selection = buildCursorModelSelection("grok-4.7@256k", "high", true);
		expect(applyCursorMaxModeSelection(selection, false)).toBe(selection);
		expect(selection.params?.some((param) => param.id === "max_mode")).toBe(false);
	});

	it("appends the max_mode sentinel when enabled and does not duplicate it", () => {
		const selection = buildCursorModelSelection("grok-4.7@500k", "high", true);
		const enabled = applyCursorMaxModeSelection(selection, true);
		expect(enabled).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "500k" },
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "true" },
				CURSOR_MAX_MODE_PARAM,
			],
		});
		expect(applyCursorMaxModeSelection(enabled, true).params?.filter((param) => param.id === "max_mode")).toEqual([
			CURSOR_MAX_MODE_PARAM,
		]);
		expect(selection.params?.some((param) => param.id === "max_mode")).toBe(false);
	});

	it("adds the sentinel when the selection has no params", () => {
		const selection: ModelSelection = { id: "composer-2" };
		expect(applyCursorMaxModeSelection(selection, true)).toEqual({
			id: "composer-2",
			params: [CURSOR_MAX_MODE_PARAM],
		});
		expect(selection.params).toBeUndefined();
	});
});

describe("Cursor Max Mode precedence", () => {
	it("uses CLI, then env, then session, then saved user config, then off", () => {
		expect(resolveCursorMaxMode({}).value).toBe(false);
		expect(resolveCursorMaxMode({ userValue: true }).value).toBe(true);
		expect(resolveCursorMaxMode({ userValue: true, sessionValue: false }).value).toBe(false);
		expect(resolveCursorMaxMode({ sessionValue: false, envValue: true }).value).toBe(true);
		expect(resolveCursorMaxMode({ envValue: true, cliForceNoMaxMode: true }).value).toBe(false);
		expect(resolveCursorMaxMode({ cliForceMaxMode: true, cliForceNoMaxMode: true, envValue: true, sessionValue: true }).value).toBe(false);
		expect(resolveCursorMaxMode({ cliForceMaxMode: true, envValue: false }).value).toBe(true);
		expect(resolveCursorMaxMode({ cliForceNoMaxMode: true }).source).toBe("cli");
		expect(resolveCursorMaxMode({ envValue: true }).source).toBe("environment");
		expect(resolveCursorMaxMode({ sessionValue: true }).source).toBe("session");
		expect(resolveCursorMaxMode({ userValue: true }).source).toBe("user");
		expect(resolveCursorMaxMode({}).source).toBe("builtin");
	});

	it("shows max:on only when Max Mode is on", () => {
		expect(formatCursorStatus("local", true, "agent", false, false)).toBe("cursor:local · fast:on");
		expect(formatCursorStatus("local", true, "agent", false, true)).toBe("cursor:local · fast:on · max:on");
		expect(formatCursorStatus("local", false, "plan", true, true)).toBe("cursor:local · fast:off · max:on · http1 · plan");
		expect(formatCursorStatus("cloud", undefined, "agent", false, true)).toBe("cursor:cloud · fast:n/a · max:on");
	});
});

describe("Cursor Max Mode session toggle", () => {
	let tmpAgentDir: string;
	let previousAgentDir: string;
	const originalEnv = process.env[CURSOR_MAX_MODE_ENV];

	beforeEach(() => {
		tmpAgentDir = mkdtempSync(join(tmpdir(), "cursor-max-mode-"));
		previousAgentDir = getAgentDir();
		setAgentDir(tmpAgentDir);
		delete process.env[CURSOR_MAX_MODE_ENV];
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	afterEach(() => {
		setAgentDir(previousAgentDir);
		if (originalEnv === undefined) delete process.env[CURSOR_MAX_MODE_ENV];
		else process.env[CURSOR_MAX_MODE_ENV] = originalEnv;
		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	function harness(options: {
		cursorMaxModeFlag?: boolean;
		cursorNoMaxModeFlag?: boolean;
		branch?: SessionEntry[];
	} = {}) {
		const binding = createDetachedCursorSessionBinding();
		const pi = createPiHarness({
			flagValues: {
				"cursor-max-mode": options.cursorMaxModeFlag ?? false,
				"cursor-no-max-mode": options.cursorNoMaxModeFlag ?? false,
			},
		});
		const ctx = createExtensionTestContext({
			cwd: tmpAgentDir,
			hasUI: true,
			model: { ...makeModel("grok-4.7@500k"), provider: "cursor-sdk", api: "cursor-sdk" },
			sessionManager: {
				getBranch: () => options.branch ?? [],
			},
		});
		const commandCtx = createExtensionCommandContext({
			cwd: ctx.cwd,
			model: ctx.model,
			ui: ctx.ui,
			sessionManager: ctx.sessionManager,
		});
		return runInCursorSessionBinding(binding, () => {
			registerCursorRuntimeControls(pi);
			__testUtils.resetCursorModeStateForTests();
			return { pi, ctx, commandCtx, commands: pi._commands };
		});
	}

	async function inSession<T>(body: () => Promise<T> | T): Promise<T> {
		return runInCursorSessionBinding(createDetachedCursorSessionBinding(), body);
	}

	it("defaults off and toggles session state without writing user config", async () => {
		const { pi, ctx, commandCtx, commands } = harness();
		await inSession(async () => {
			await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
			expect(getEffectiveCursorMaxMode()).toBe(false);
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", expect.not.stringContaining("max:"));
			await commands.get("cursor-max-mode")!.handler("on", commandCtx);
			expect(getEffectiveCursorMaxMode()).toBe(true);
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", expect.stringContaining("max:on"));
			expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MAX_MODE_ENTRY_TYPE, { enabled: true });
		});
		expect(() => readFileSync(getCursorSdkUserConfigPath(), "utf8")).toThrow();
	});

	it("persists only user config when --save-user is passed", async () => {
		const { pi, ctx, commandCtx, commands } = harness();
		await inSession(async () => {
			await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
			await commands.get("cursor-max-mode")!.handler("on --save-user", commandCtx);
		});
		expect(JSON.parse(readFileSync(getCursorSdkUserConfigPath(), "utf8"))).toEqual({ maxMode: true });
		expect(() => readFileSync(join(tmpAgentDir, ".omp", "cursor-sdk.json"), "utf8")).toThrow();
	});

	it("lets CLI beat session and saved user state", async () => {
		writeFileSync(getCursorSdkUserConfigPath(), JSON.stringify({ maxMode: true }));
		const branch = [{
			type: "custom",
			customType: __testUtils.MAX_MODE_ENTRY_TYPE,
			data: { enabled: true },
		}] as SessionEntry[];
		await inSession(async () => {
			const saved = harness({ branch });
			await saved.pi.invokeEventWithContext("session_start", { type: "session_start" }, saved.ctx);
			expect(getEffectiveCursorMaxMode()).toBe(true);
			const cliOff = harness({ cursorNoMaxModeFlag: true, branch });
			await cliOff.pi.invokeEventWithContext("session_start", { type: "session_start" }, cliOff.ctx);
			expect(getEffectiveCursorMaxMode()).toBe(false);
			expect(cliOff.ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", expect.not.stringContaining("max:"));
		});
	});

	it("does not persist while a CLI force flag is active", async () => {
		const { pi, ctx, commandCtx, commands } = harness({ cursorMaxModeFlag: true });
		await inSession(async () => {
			await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
			await commands.get("cursor-max-mode")!.handler("off --save-user", commandCtx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("--cursor-max-mode"), "info");
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(getEffectiveCursorMaxMode()).toBe(true);
		});
	});

	it("does not persist while PI_CURSOR_MAX_MODE forces the value", async () => {
		writeFileSync(getCursorSdkUserConfigPath(), JSON.stringify({ maxMode: true }));
		const before = readFileSync(getCursorSdkUserConfigPath(), "utf8");
		const cases = [
			{ env: "1", args: "off", effective: true },
			{ env: "1", args: "off --save-user", effective: true },
			{ env: "0", args: "on", effective: false },
			{ env: "0", args: "on --save-user", effective: false },
		] as const;
		for (const { env, args, effective } of cases) {
			const { pi, ctx, commandCtx, commands } = harness();
			await inSession(async () => {
				await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
				process.env[CURSOR_MAX_MODE_ENV] = env;
				try {
					await commands.get("cursor-max-mode")!.handler(args, commandCtx);
					expect(getEffectiveCursorMaxMode()).toBe(effective);
				} finally {
					delete process.env[CURSOR_MAX_MODE_ENV];
				}
				expect(ctx.ui.notify).toHaveBeenCalledWith("Cursor Max Mode is forced by PI_CURSOR_MAX_MODE", "info");
				expect(pi.appendEntry).not.toHaveBeenCalled();
				expect(getEffectiveCursorMaxMode()).toBe(true);
			});
			expect(readFileSync(getCursorSdkUserConfigPath(), "utf8")).toBe(before);
		}
	});
});

describe("Cursor Max Mode SDK patch guard", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cursor-max-mode-sdk-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("fails loud when the resolved SDK build files are unpatched", () => {
		const resolved = writeSdkFixture(root, {
			"dist/esm/34.js": UNPATCHED_ESM,
			"dist/bundled/index.js": "new d5({modelId:m.model.id,parameters:(m.model.params??[]).map((G1)=>new U$({id:G1.id,value:G1.value}))})",
		});
		const startedBeforeFixture = Date.now() + 60_000;
		expect(() => assertCursorSdkMaxModePatched(resolved, { processStartedAtMs: startedBeforeFixture })).toThrow(resolved);
		try {
			assertCursorSdkMaxModePatched(resolved, { processStartedAtMs: startedBeforeFixture });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("npm run patch:cursor-sdk");
			expect((error as Error).message).toContain("dist/esm/34.js");
			expect((error as Error).message).toContain("dist/bundled/index.js");
		}
	});

	it("passes when every existing build file contains the patch marker", () => {
		const resolved = writeSdkFixture(root, {
			"dist/esm/34.js": `new x.G4({maxMode:true${CURSOR_MAX_MODE_PATCH_MARKER}})`,
			"dist/cjs/342.js": CURSOR_MAX_MODE_PATCH_MARKER,
		});
		// The fixture is written now, so a process that started later than that loaded the patched file.
		expect(() => assertCursorSdkMaxModePatched(resolved, { processStartedAtMs: Date.now() + 60_000 })).not.toThrow();
	});

	it("fails loud when a patched build file is newer than this process", () => {
		const resolved = writeSdkFixture(root, { "dist/esm/34.js": `new x.G4({maxMode:true${CURSOR_MAX_MODE_PATCH_MARKER}})` });
		try {
			assertCursorSdkMaxModePatched(resolved, { processStartedAtMs: Date.now() - 60_000 });
			throw new Error("expected the stale patch to fail the guard");
		} catch (error) {
			expect((error as Error).message).toMatch(/restart omp/i);
			expect((error as Error).message).toContain("dist/esm/34.js");
		}
	});

	it("locates the SDK on disk when the runtime cannot resolve the bare specifier", () => {
		// Mirrors a Bun single-file compiled binary (the shipping omp): the resolver API throws,
		// while the on-disk node_modules chain the real import uses is intact.
		const sdkRoot = join(root, "node_modules", "@cursor", "sdk");
		writeSdkFixture(sdkRoot, {
			"dist/esm/34.js": `new x.G4({maxMode:true${CURSOR_MAX_MODE_PATCH_MARKER}})`,
		});
		const moduleUrl = pathToFileURL(join(root, "consumer", "src", "cursor-max-mode.js")).href;
		const unresolvable = () => {
			throw new Error(`Cannot find package '@cursor/sdk' imported from ${moduleUrl}`);
		};

		const resolved = resolveImportedCursorSdkPath(moduleUrl, unresolvable);

		expect(resolved).toBe(pathToFileURL(join(sdkRoot, "package.json")).href);
		expect(() => assertCursorSdkMaxModePatched(resolved, { processStartedAtMs: Date.now() + 60_000 })).not.toThrow();
	});

	it("fails loud when the runtime cannot resolve the SDK and no on-disk package exists", () => {
		const moduleUrl = pathToFileURL(join(root, "consumer", "src", "cursor-max-mode.js")).href;

		expect(() =>
			resolveImportedCursorSdkPath(moduleUrl, () => {
				throw new Error("Cannot find package '@cursor/sdk'");
			}),
		).toThrow(/could not be located/);
	});
});
