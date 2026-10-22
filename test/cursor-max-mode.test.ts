import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Agent, type ModelListItem, type ModelSelection, type ModelVariant } from "@cursor/sdk";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_MAX_MODE_ENV, getCursorSdkUserConfigPath, resolveCursorMaxMode, resolveCursorSdkConfig } from "../src/cursor-config.js";
import { applyCursorMaxModeSelection, selectCursorMaxModeSelection } from "../src/cursor-max-mode.js";
import { __testUtils as cloudLifecycleTestUtils, registerCursorCloudLifecycleLedger } from "../src/cursor-cloud-lifecycle.js";
import { restoreCursorMcpToolTimeoutOverride } from "../src/cursor-mcp-timeout-override.js";
import { prepareCursorProviderTurn, resolveCursorProviderTurnConfig } from "../src/cursor-provider-turn-prepare.js";
import { sendCursorProviderTurn } from "../src/cursor-provider-turn-send.js";
import { disposeAllSessionCursorAgents } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";
import {
	getEffectiveCursorMaxMode,
	registerCursorRuntimeControls,
	__testUtils,
} from "../src/cursor-state.js";
import { createDetachedCursorSessionBinding, runInCursorSessionBinding } from "../src/cursor-session-binding.js";
import { formatCursorStatus } from "../src/cursor-runtime-state.js";
import { buildCursorModelSelection, isCursorSelectionMaxModeOnly, __testUtils as modelDiscoveryTestUtils } from "../src/model-discovery.js";
import { CURSOR_SDK_BUILDS, CURSOR_SDK_ROOT, readCursorSdkBuildSource } from "./helpers/cursor-sdk-build-source.js";
import { createAgentsInBuild, offlineAgentRuntime } from "./helpers/cursor-sdk-offline-agent.js";
import {
	createExtensionCommandContext,
	createExtensionTestContext,
	createPiHarness,
	makeModel,
} from "./helpers/pi-harness.js";

sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async () => ({ dispose: async () => {} }) as never,
});

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

describe("Cursor Max Mode selection", () => {
	beforeEach(() => {
		modelDiscoveryTestUtils.registerModelItems(modelItems);
	});

	it("leaves a disabled selection unchanged", () => {
		const selection = buildCursorModelSelection("grok-4.7@256k", "high", true);
		expect(applyCursorMaxModeSelection(selection, false)).toBe(selection);
		expect(selection).not.toHaveProperty("maxMode");
	});

	it("sets the native maxMode field, sends no max_mode param, and does not mutate or repeat itself", () => {
		const selection = buildCursorModelSelection("grok-4.7@500k", "high", true);
		const enabled = applyCursorMaxModeSelection(selection, true);
		expect(enabled).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "500k" },
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "true" },
			],
			maxMode: true,
		});
		expect(enabled.params?.some((param) => param.id === "max_mode")).toBe(false);
		expect(selection).not.toHaveProperty("maxMode");
		expect(applyCursorMaxModeSelection(enabled, true)).toBe(enabled);
	});

	it("sets maxMode on a selection without params", () => {
		const selection: ModelSelection = { id: "composer-2" };
		expect(applyCursorMaxModeSelection(selection, true)).toEqual({ id: "composer-2", maxMode: true });
		expect(selection).not.toHaveProperty("maxMode");
	});
});

// Catalog shapes seen live on 2026-10-22: `ModelVariant.isMaxMode` marks a variant that cannot run outside Max Mode.
const maxModeCatalog: ModelListItem[] = [
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
				displayName: "Grok 4.7 256k",
				isDefault: true,
			},
			{
				params: [
					{ id: "context", value: "500k" },
					{ id: "reasoning_effort", value: "high" },
					{ id: "fast", value: "true" },
				],
				displayName: "Grok 4.7 500k",
				isMaxMode: true,
			},
		],
	},
	{
		// Only the fast 300k and the 1m variants are Max Mode only (claude-opus-4-8 shape).
		id: "claude-opus-4-8",
		displayName: "Opus 4.8",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{ params: [{ id: "context", value: "300k" }, { id: "fast", value: "false" }], displayName: "Opus 4.8 300k", isDefault: true },
			{ params: [{ id: "context", value: "300k" }, { id: "fast", value: "true" }], displayName: "Opus 4.8 300k fast", isMaxMode: true },
			{ params: [{ id: "context", value: "1m" }, { id: "fast", value: "false" }], displayName: "Opus 4.8 1m", isMaxMode: true },
			{ params: [{ id: "context", value: "1m" }, { id: "fast", value: "true" }], displayName: "Opus 4.8 1m fast", isMaxMode: true },
		],
	},
	{
		// The catalog lists no `1m` + fast=true variant (gpt-5.5 shape): nothing says Max Mode is required.
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "272k" }, { value: "1m" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{ params: [{ id: "context", value: "272k" }, { id: "fast", value: "false" }], displayName: "GPT-5.5 272k", isDefault: true },
			{ params: [{ id: "context", value: "272k" }, { id: "fast", value: "true" }], displayName: "GPT-5.5 272k fast" },
			{ params: [{ id: "context", value: "1m" }, { id: "fast", value: "false" }], displayName: "GPT-5.5 1m", isMaxMode: true },
		],
	},
	// No variant information at all.
	{ id: "composer-2", displayName: "Composer 2", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }] },
];

const turn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const piModel = (id: string) => ({ id, api: "cursor-sdk", provider: "cursor-sdk", reasoning: false }) as unknown as Model;

describe("Cursor Max Mode on a local turn", () => {
	const ripgrepPath = process.env.CURSOR_RIPGREP_PATH;

	beforeEach(() => {
		modelDiscoveryTestUtils.registerModelItems(maxModeCatalog);
		delete process.env[CURSOR_MAX_MODE_ENV];
	});

	afterEach(async () => {
		await disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.reset();
		restoreCursorMcpToolTimeoutOverride();
		delete process.env[CURSOR_MAX_MODE_ENV];
		// Local prepare sets the bundled ripgrep path process-wide.
		if (ripgrepPath === undefined) delete process.env.CURSOR_RIPGREP_PATH;
		else process.env.CURSOR_RIPGREP_PATH = ripgrepPath;
	});

	// Runs a local turn for `modelId`: the model handed to Agent.create, how often it was called, and the
	// error that stopped the turn before that, if any.
	async function localTurn(modelId: string) {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/max-mode.jsonl");
		// Under Bun the provider's lazy `import("@cursor/sdk")` returns this same module.
		const create = vi.spyOn(Agent, "create").mockResolvedValue({ agentId: "agent-local", [Symbol.asyncDispose]: async () => {} } as never);
		let refusal: string | undefined;
		let calls: Array<Parameters<typeof Agent.create>> = [];
		try {
			const prepared = await prepareCursorProviderTurn({
				params: { model: piModel(modelId), context: turn, options: {}, stream: {} as never, partial: {} as never, sdkEventDebugRef: { current: undefined } } as never,
				cwd: "/tmp/project",
				resolvedApiKey: "test-key",
				sdkEventDebug: undefined,
				throwIfAborted: () => {},
				resolvedConfig: resolveCursorProviderTurnConfig("/tmp/project"),
				oneShot: false,
				conversationId: "01a0e2a0-0000-7000-8000-000000000001",
				mainConversation: true,
			});
			await prepared.lifecycle.dispose();
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		} finally {
			calls = [...create.mock.calls];
			create.mockRestore();
		}
		return { refusal, model: calls[0]?.[0]?.model, created: calls.length };
	}

	function paramIds(model: unknown): string[] {
		return typeof model === "object" && model !== null && "params" in model && Array.isArray(model.params)
			? model.params.map((param: { id: string }) => param.id)
			: [];
	}

	it("creates the agent with maxMode: true and no max_mode param while Max Mode is on (the default)", async () => {
		const { model } = await localTurn("grok-4.7@500k");
		expect(model).toMatchObject({ id: "grok-4.7", maxMode: true });
		expect(paramIds(model)).toEqual(["context", "reasoning_effort", "fast"]);
	});

	it("forces maxMode on a variant the catalog does not require it for when Max Mode is on", async () => {
		const { model } = await localTurn("claude-opus-4-8@300k");
		expect(model).toMatchObject({ id: "claude-opus-4-8", maxMode: true });
	});

	it("creates the agent without maxMode when Max Mode is off and the variant does not need it", async () => {
		process.env[CURSOR_MAX_MODE_ENV] = "0";
		const { model, created } = await localTurn("claude-opus-4-8@300k");
		expect(created).toBe(1);
		expect(model).toMatchObject({ id: "claude-opus-4-8" });
		expect(model).not.toHaveProperty("maxMode");
		expect(paramIds(model)).not.toContain("max_mode");
	});

	it("refuses, before any agent exists, a Max Mode only variant while Max Mode is off", async () => {
		process.env[CURSOR_MAX_MODE_ENV] = "0";
		const { refusal, created } = await localTurn("grok-4.7@500k");
		expect(created).toBe(0);
		expect(refusal).toContain("Max Mode is off, but cursor-sdk/grok-4.7@500k selects a variant Cursor lists as Max Mode only");
		expect(refusal).toContain("context=500k");
		expect(refusal).toContain("bill Max Mode rates");
		expect(refusal).toContain("--cursor-max-mode, /cursor-max-mode on, or PI_CURSOR_MAX_MODE=1");
		// The catalog lists the smaller context as a variant that does not need Max Mode. `@256k` and `@256k@fast`
		// select it alike (its default lane is fast): the explicit lane is listed once. The slow lanes list no variant.
		expect(refusal).toContain("pick a variant that does not need it: cursor-sdk/grok-4.7@256k@fast.");
	});

	it("names the lane and context that avoid Max Mode, and only variants the catalog lists as not needing it", async () => {
		process.env[CURSOR_MAX_MODE_ENV] = "0";
		// fast=true at 300k is Max Mode only; the @slow lane at 300k is not. 1m is Max Mode only in either lane.
		const fast = await localTurn("claude-opus-4-8@300k@fast");
		expect(fast.created).toBe(0);
		expect(fast.refusal).toContain("cursor-sdk/claude-opus-4-8@300k@fast selects a variant Cursor lists as Max Mode only");
		expect(fast.refusal).toContain("pick a variant that does not need it: cursor-sdk/claude-opus-4-8@300k@slow.");
		for (const modelId of ["claude-opus-4-8@1m", "claude-opus-4-8@1m@fast", "claude-opus-4-8@1m@slow"]) {
			const { refusal, created } = await localTurn(modelId);
			expect(created, modelId).toBe(0);
			expect(refusal, modelId).toContain("selects a variant Cursor lists as Max Mode only");
			expect(refusal, modelId).toContain("claude-opus-4-8@300k@slow");
			expect(refusal, modelId).not.toContain("1m@slow.");
		}
	});

	it("never refuses a variant the catalog does not list or has no variant information for", async () => {
		process.env[CURSOR_MAX_MODE_ENV] = "0";
		// gpt-5.5 has no 1m fast=true variant, so nothing marks that selection as Max Mode only.
		const unlisted = await localTurn("gpt-5.5@1m@fast");
		expect(unlisted.created).toBe(1);
		expect(unlisted.model).not.toHaveProperty("maxMode");
		const bare = await localTurn("composer-2");
		expect(bare.created).toBe(1);
		expect(bare.model).not.toHaveProperty("maxMode");
	});

	it("lets the toggle override the refusal: Max Mode on runs the Max Mode only variant", async () => {
		process.env[CURSOR_MAX_MODE_ENV] = "1";
		const { model, created } = await localTurn("grok-4.7@500k");
		expect(created).toBe(1);
		expect(model).toMatchObject({ id: "grok-4.7", maxMode: true });
	});
});

describe("Cursor Max Mode on a Cursor Cloud turn", () => {
	const CLOUD_AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";
	const CLOUD_RUN_ID = "run-00000000-0000-0000-0000-000000000001";
	const cloudModelConfig = resolveCursorSdkConfig({
		env: {},
		builtIn: { runtime: "cloud", cloud: { contextHandoff: "fresh", acknowledged: true, allowLocalState: true } },
	});
	const cloudRun = { id: CLOUD_RUN_ID, requestId: "request-1", agentId: CLOUD_AGENT_ID, status: "running", cancel: vi.fn().mockResolvedValue(undefined) };

	beforeEach(() => {
		modelDiscoveryTestUtils.registerModelItems(maxModeCatalog);
		delete process.env[CURSOR_MAX_MODE_ENV];
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/max-mode-cloud.jsonl");
		cloudLifecycleTestUtils.reset();
		registerCursorCloudLifecycleLedger({ on: () => {}, appendEntry: () => {} } as never);
		cloudLifecycleTestUtils.setDurableWriter(() => true);
	});

	afterEach(() => {
		delete process.env[CURSOR_MAX_MODE_ENV];
		cloudLifecycleTestUtils.reset();
		cursorSessionScopeTestUtils.reset();
	});

	// Prepares and sends a cloud turn; resolves with the model handed to Agent.create and to agent.send.
	async function cloudTurn(modelId: string) {
		const agentSend = vi.fn().mockResolvedValue(cloudRun);
		const create = vi
			.spyOn(Agent, "create")
			.mockResolvedValue({ agentId: CLOUD_AGENT_ID, send: agentSend, [Symbol.asyncDispose]: async () => {} } as never);
		try {
			const params = { model: piModel(modelId), context: turn, options: {}, stream: {} as never, partial: {} as never, sdkEventDebugRef: { current: undefined } };
			const prepared = await prepareCursorProviderTurn({
				params: params as never,
				cwd: "/tmp/project",
				resolvedApiKey: "test-key",
				sdkEventDebug: undefined,
				throwIfAborted: () => {},
				resolvedConfig: cloudModelConfig,
			});
			const sendResult = await sendCursorProviderTurn({
				params: params as never,
				prepared,
				sdkEventDebug: undefined,
				sdkProcessErrorGuard: { suppressAbortErrors: vi.fn() } as never,
				throwIfAborted: () => {},
				resolvedApiKey: "test-key",
			});
			sendResult.abortRegistration?.signal.removeEventListener("abort", sendResult.abortRegistration.listener);
			await prepared.lifecycle.dispose();
			return {
				created: create.mock.calls.length,
				createModel: create.mock.calls[0]?.[0]?.model,
				sendModel: agentSend.mock.calls[0]?.[1]?.model,
				preparedModel: prepared.meta.modelSelection,
			};
		} finally {
			create.mockRestore();
		}
	}

	it("sends no maxMode to Agent.create or agent.send with Max Mode on (the default): the Cloud Agents API rejects the key", async () => {
		const turnResult = await cloudTurn("grok-4.7@500k");
		expect(turnResult.created).toBe(1);
		for (const model of [turnResult.createModel, turnResult.sendModel, turnResult.preparedModel]) {
			expect(model).toMatchObject({ id: "grok-4.7", params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }] });
			expect(model).not.toHaveProperty("maxMode");
		}
	});

	it("neither sends maxMode nor refuses a Max Mode only variant with Max Mode off: the refusal is for local agents", async () => {
		process.env[CURSOR_MAX_MODE_ENV] = "0";
		const turnResult = await cloudTurn("grok-4.7@500k");
		expect(turnResult.created).toBe(1);
		expect(turnResult.sendModel).toMatchObject({ id: "grok-4.7" });
		expect(turnResult.sendModel).not.toHaveProperty("maxMode");
	});
});

describe("selectCursorMaxModeSelection", () => {
	beforeEach(() => {
		modelDiscoveryTestUtils.registerModelItems(maxModeCatalog);
	});

	it("returns a Cloud selection untouched whatever the toggle and the catalog say", () => {
		const maxOnly = buildCursorModelSelection("grok-4.7@500k", "high");
		for (const enabled of [true, false]) {
			expect(selectCursorMaxModeSelection("grok-4.7@500k", maxOnly, { runtime: "cloud", enabled })).toBe(maxOnly);
		}
	});

	it("returns a local selection untouched with Max Mode off when nothing marks it Max Mode only", () => {
		const plain = buildCursorModelSelection("grok-4.7@256k", "high");
		expect(selectCursorMaxModeSelection("grok-4.7@256k", plain, { runtime: "local", enabled: false })).toBe(plain);
		// An id the catalog never registered has no variant information either.
		const unknown: ModelSelection = { id: "not-registered", params: [{ id: "context", value: "1m" }] };
		expect(selectCursorMaxModeSelection("not-registered", unknown, { runtime: "local", enabled: false })).toBe(unknown);
	});

	it("applies the SDK's variant rule: every matching variant must be Max Mode only, and a params-free selection matches none", () => {
		// context=300k matches both the Max Mode only fast variant and the plain one.
		const partial: ModelSelection = { id: "claude-opus-4-8", params: [{ id: "context", value: "300k" }] };
		expect(selectCursorMaxModeSelection("claude-opus-4-8@300k", partial, { runtime: "local", enabled: false })).toBe(partial);
		const bare: ModelSelection = { id: "claude-opus-4-8" };
		expect(selectCursorMaxModeSelection("claude-opus-4-8@1m", bare, { runtime: "local", enabled: false })).toBe(bare);
		const onlyMax: ModelSelection = { id: "claude-opus-4-8", params: [{ id: "context", value: "1m" }] };
		expect(() => selectCursorMaxModeSelection("claude-opus-4-8@1m", onlyMax, { runtime: "local", enabled: false })).toThrow("Max Mode only");
	});
});

describe("Cursor Max Mode precedence", () => {
	it("uses CLI, then env, then session, then saved user config, then on", () => {
		expect(resolveCursorMaxMode({}).value).toBe(true);
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
		// Only a local turn sends Max Mode; the Cloud Agents API rejects the field.
		expect(formatCursorStatus("cloud", undefined, "agent", false, true)).toBe("cursor:cloud · fast:n/a");
		expect(formatCursorStatus("invalid", undefined, "agent", false, true)).toBe("cursor:invalid · fast:n/a");
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

	it("defaults on and toggles session state without writing user config", async () => {
		const { pi, ctx, commandCtx, commands } = harness();
		await inSession(async () => {
			await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
			expect(getEffectiveCursorMaxMode()).toBe(true);
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", expect.stringContaining("max:on"));
			await commands.get("cursor-max-mode")!.handler("off", commandCtx);
			expect(getEffectiveCursorMaxMode()).toBe(false);
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("cursor", expect.not.stringContaining("max:"));
			expect(pi.appendEntry).toHaveBeenCalledWith(__testUtils.MAX_MODE_ENTRY_TYPE, { enabled: false });
		});
		expect(() => readFileSync(getCursorSdkUserConfigPath(), "utf8")).toThrow();
	});

	describe("warning when switching off for a Max Mode only model", () => {
		// grok-4.7@500k, the harness's current model, is Max Mode only in maxModeCatalog (and not in modelItems).
		async function disable(args: string) {
			const { pi, ctx, commandCtx, commands } = harness();
			return inSession(async () => {
				await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
				await commands.get("cursor-max-mode")!.handler(args, commandCtx);
				return ctx.ui.notify as Mock;
			});
		}

		it("says the next turn will be refused and names the variants that avoid Max Mode", async () => {
			modelDiscoveryTestUtils.registerModelItems(maxModeCatalog);
			for (const args of ["off", "toggle", "off --save-user"]) {
				const notify = await disable(args);
				const [message, level] = notify.mock.calls.at(-1) ?? [];
				expect(message, args).toContain("Cursor Max Mode disabled.");
				expect(message, args).toContain("cursor-sdk/grok-4.7@500k is a variant Cursor lists as Max Mode only, so its next turn will be refused while Max Mode is off.");
				expect(message, args).toContain("Turn Max Mode back on, or pick a variant that does not need it: cursor-sdk/grok-4.7@256k@fast.");
				expect(level, args).toBe("warning");
			}
		});

		it("adds nothing when the current model does not need Max Mode", async () => {
			// `modelItems` lists no Max Mode only variant, and the toggle off on `@256k` is just a switch.
			modelDiscoveryTestUtils.registerModelItems(modelItems);
			const notify = await disable("off");
			expect(notify).toHaveBeenLastCalledWith("Cursor Max Mode disabled.", "info");
		});

		it("adds nothing on the cloud runtime, where Max Mode is ignored and no turn is refused", async () => {
			modelDiscoveryTestUtils.registerModelItems(maxModeCatalog);
			process.env.PI_CURSOR_RUNTIME = "cloud";
			try {
				const notify = await disable("off");
				expect(notify).toHaveBeenLastCalledWith("Cursor Max Mode disabled.", "info");
			} finally {
				delete process.env.PI_CURSOR_RUNTIME;
			}
		});

		it("adds nothing when the current model is not a Cursor model", async () => {
			modelDiscoveryTestUtils.registerModelItems(maxModeCatalog);
			const { pi, ctx, commandCtx, commands } = harness();
			const other = { ...commandCtx, model: { ...makeModel("gpt-5"), provider: "openai", api: "openai-responses" } };
			await inSession(async () => {
				await pi.invokeEventWithContext("session_start", { type: "session_start" }, ctx);
				await commands.get("cursor-max-mode")!.handler("off", other as never);
			});
			expect(ctx.ui.notify).toHaveBeenLastCalledWith("Cursor Max Mode disabled.", "info");
		});
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

describe("installed @cursor/sdk native Max Mode contract", () => {
	// Observed in the live catalog on 2026-10-22: every grok-4.7 context=500k variant is isMaxMode, no 256k variant is.
	const nativeCatalog: ModelListItem = {
		id: "grok-4.7",
		displayName: "Grok 4.7",
		parameters: [
			{ id: "context", values: [{ value: "256k" }, { value: "500k" }] },
			{ id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] },
			{ id: "fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: ["256k", "500k"].flatMap((context) =>
			["low", "high"].flatMap((effort) =>
				["false", "true"].map((fast) => ({
					params: [
						{ id: "context", value: context },
						{ id: "reasoning_effort", value: effort },
						{ id: "fast", value: fast },
					],
					displayName: `Grok 4.7 ${context} ${effort} fast=${fast}`,
					...(context === "500k" ? { isMaxMode: true } : {}),
				})),
			),
		),
	};
	const selectionAt = (context: string): ModelSelection => ({
		id: "grok-4.7",
		params: [
			{ id: "context", value: context },
			{ id: "reasoning_effort", value: "low" },
			{ id: "fast", value: "false" },
		],
	});

	it("types Max Mode on a selection and on the catalog variants that require it", () => {
		const declaration = readFileSync(join(CURSOR_SDK_ROOT, "dist/esm/options.d.ts"), "utf8");
		expect(declaration).toMatch(/interface ModelSelection \{[^}]*\bmaxMode\?: boolean;/);
		expect(declaration).toMatch(/interface ModelVariant \{[^}]*\bisMaxMode\?: boolean;/);
		// Compile-time: these fields exist on the installed types.
		({ id: "grok-4.7", maxMode: true }) satisfies ModelSelection;
		({ params: [], displayName: "Grok 4.7 500k", isMaxMode: true }) satisfies ModelVariant;
	});

	describe.each(CURSOR_SDK_BUILDS)("%s build", (build) => {
		it("copies ModelSelection.maxMode onto the local request, and hands a cloud agent's selection to the REST request whole", () => {
			const source = readCursorSdkBuildSource(build);
			// The local executor's request model: maxMode is added only when the selection carries it.
			const localRequestModel =
				/modelId:([\w$]+)\.model\.id,\.\.\.\1\.model\.maxMode===!0\?\{maxMode:!0\}:\{\},parameters:\(\1\.model\.params\?\?\[\]\)\.map\(/g;
			expect([...source.matchAll(localRequestModel)]).toHaveLength(1);
			// The cloud agent's create and run requests carry the selection object whole, so a `maxMode` the plugin
			// put on a cloud selection would reach the Cloud Agents API, which rejects it. The plugin leaves it off.
			const cloudCreateModel =
				/createServerAgent\([\w$]+,\{\.\.\.[\w$]+\?\{\}:\{agentId:this\.agentId\},prompt:[\w$]+,\.\.\.([\w$]+)!==void 0\?\{model:\1\}:\{\}/g;
			const cloudRunModel =
				/createRun\(this\.agentId,\{prompt:[\w$]+,mcpServers:[\w$]+\([\w$]+\),\.\.\.([\w$]+)\?\.model!==void 0\?\{model:\1\.model\}:\{\}/g;
			expect([...source.matchAll(cloudCreateModel)]).toHaveLength(1);
			expect([...source.matchAll(cloudRunModel)]).toHaveLength(1);
		});

		it.skipIf(offlineAgentRuntime(build) === undefined)(
			"sets maxMode itself exactly where the plugin's Max Mode only rule says, and keeps an explicit one",
			() => {
				// The child feeds the SDK a catalog through its own offline override.
				expect(readCursorSdkBuildSource(build)).toContain("CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON");
				const selections: Record<string, ModelSelection> = {
					required: selectionAt("500k"),
					plain: selectionAt("256k"),
					// Matches every 500k variant, all Max Mode only.
					partialMax: { id: "grok-4.7", params: [{ id: "context", value: "500k" }] },
					// Matches the 256k and the 500k variants: not every one is Max Mode only.
					partialMixed: { id: "grok-4.7", params: [{ id: "fast", value: "false" }] },
					// Matches no variant.
					unlisted: { id: "grok-4.7", params: [{ id: "context", value: "1m" }] },
					noParams: { id: "grok-4.7" },
				};
				const resolved = createAgentsInBuild(
					build,
					{
						...Object.fromEntries(Object.entries(selections).map(([label, model]) => [label, { model }])),
						forced: { model: applyCursorMaxModeSelection(selectionAt("256k"), true) },
					},
					[nativeCatalog],
				);
				modelDiscoveryTestUtils.registerModelItems([nativeCatalog]);
				for (const [label, selection] of Object.entries(selections)) {
					const result = resolved[label];
					const sdkForcedMaxMode = result !== undefined && "model" in result && result.model?.maxMode === true;
					expect(isCursorSelectionMaxModeOnly("grok-4.7@256k", selection), label).toBe(sdkForcedMaxMode);
					// The SDK keeps the params it was given.
					expect(result, label).toEqual({ model: sdkForcedMaxMode ? { ...selection, maxMode: true } : selection });
				}
				expect(resolved.required).toEqual({ model: { ...selectionAt("500k"), maxMode: true } });
				expect(resolved.plain).toEqual({ model: selectionAt("256k") });
				// An explicit maxMode on a variant that does not need it is kept.
				expect(resolved.forced).toEqual({ model: { ...selectionAt("256k"), maxMode: true } });
			},
			60_000,
		);
	});
});
