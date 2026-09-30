import { Agent, type ToolName } from "@cursor/sdk";
import { SUMMARIZATION_SYSTEM_PROMPT } from "@oh-my-pi/pi-agent-core/compaction/utils";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreCursorMcpToolTimeoutOverride } from "../src/cursor-mcp-timeout-override.js";
import { getCursorBuiltInToolAllowlist } from "../src/cursor-one-shot-request.js";
import { prepareCursorProviderTurn, resolveCursorProviderTurnConfig } from "../src/cursor-provider-turn-prepare.js";
import { acquireSessionCursorAgent, createOneShotCursorAgent, disposeAllSessionCursorAgents } from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";

sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async () => ({ dispose: async () => {} }) as never,
});

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "/tmp/sessions/advisor-tools.jsonl";
const MAIN_SESSION_ID = "01a0e2a0-0000-7000-8000-000000000001";
const ADVISOR_SESSION_ID = "01a0e2a0-0000-7000-8000-0000000000ad";
const model = { id: "composer-2.5", api: "cursor-sdk", provider: "cursor-sdk", reasoning: false } as unknown as Model;

function tool(name: string) {
	return { name, description: name, parameters: {} as never };
}

// session-advisors.ts: an advisor loop runs `[adviseTool, ...tools]`, with the tools its
// WATCHDOG.yml `tools` grants (default read, grep, glob and recall).
function advisorTurn(grantedTools: string[]): Context {
	return {
		systemPrompt: ["advisor prompt"],
		messages: [{ role: "user", content: "Review the diff", timestamp: 1 }],
		tools: ["advise", ...grantedTools].map(tool),
	};
}

const mainTurn: Context = {
	systemPrompt: ["omp system prompt"],
	messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }],
	tools: ["read", "bash", "edit", "grep"].map(tool),
};

// compaction.ts builds this bare shape; session-advisors.ts #maintainAdvisorContext sends it to
// the advisor's own model under the advisor's session id, with the advisor transcript inside.
const summarizerTurn: Context = {
	systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT],
	messages: [{ role: "user", content: "<conversation>Run the deploy brief</conversation>", timestamp: 1 }],
};

describe("Cursor built-in tool allowlist", () => {
	it("gives an advisor only the read-only built-in tools omp granted it", () => {
		// omp can grant an advisor any builtin tool, but Cursor's own shell, edit and MCP tools
		// would run outside omp's tool grants and approval policies.
		expect(getCursorBuiltInToolAllowlist(advisorTurn(["read", "grep", "glob", "recall", "bash", "edit", "write", "task"]))).toEqual([
			"read",
			"grep",
			"glob",
		]);
		expect(getCursorBuiltInToolAllowlist(advisorTurn(["read"]))).toEqual(["read"]);
		expect(getCursorBuiltInToolAllowlist(advisorTurn(["bash"]))).toEqual([]);
	});

	it("runs every summarizer text only, including one compacting an advisor's context", () => {
		expect(getCursorBuiltInToolAllowlist(summarizerTurn)).toEqual([]);
	});

	it("leaves every other request on the SDK's default toolset", () => {
		expect(getCursorBuiltInToolAllowlist(mainTurn)).toBeUndefined();
		expect(getCursorBuiltInToolAllowlist({ ...mainTurn, tools: undefined })).toBeUndefined();
	});
});

describe("advisor Cursor agents", () => {
	afterEach(async () => {
		await disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.reset();
	});

	function agentMock(agentId: string) {
		return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
	}

	function agentParams(agentId: string, conversation: { conversationId: string; mainConversation: boolean; builtInTools?: ToolName[] }) {
		const createAgent = vi.fn().mockResolvedValue(agentMock(agentId));
		return {
			createAgent,
			params: {
				apiKey: "test-key",
				agentMode: "agent" as const,
				cwd: "/tmp/project",
				modelSelection: { id: "composer-2.5" },
				...conversation,
				createAgent: createAgent as never,
			},
		};
	}

	const advisor = (builtInTools: ToolName[]) => ({ conversationId: ADVISOR_SESSION_ID, mainConversation: false, builtInTools });

	it("creates pooled and one-shot advisor agents with only the allowed built-in tools", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		const pooled = agentParams("agent-advisor", advisor(["read", "grep", "glob"]));
		await acquireSessionCursorAgent(pooled.params);
		expect(pooled.createAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "grep", "glob"] }));

		const oneShot = agentParams("agent-advisor-one-shot", advisor([]));
		const lease = await createOneShotCursorAgent(oneShot.params);
		expect(oneShot.createAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
		await lease.dispose();

		const main = agentParams("agent-main", { conversationId: MAIN_SESSION_ID, mainConversation: true });
		await acquireSessionCursorAgent(main.params);
		expect(main.createAgent.mock.calls[0]?.[0]).not.toHaveProperty("tools");
	});

	it("replaces an advisor's pooled agent between turns when its tool grant changes", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		// omp keys an advisor's provider session id by primary session and advisor slug
		// (advisor/config.ts getOrCreateAdvisorProviderSessionId), so the conversation id
		// survives a WATCHDOG.yml edit that narrows the advisor's tools.
		const broad = agentParams("agent-advisor-broad", advisor(["read", "grep", "glob"]));
		const first = await acquireSessionCursorAgent(broad.params);
		first.commitSend(advisorTurn(["read", "grep", "glob"]), true);

		const narrow = agentParams("agent-advisor-narrow", advisor(["read"]));
		const second = await acquireSessionCursorAgent(narrow.params);
		expect(second.agent.agentId).toBe("agent-advisor-narrow");
		expect(narrow.createAgent).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read"] }));
		expect(first.agent[Symbol.asyncDispose]).toHaveBeenCalled();
	});
});

describe("advisor requests on the Cursor cloud runtime", () => {
	afterEach(() => {
		delete process.env.PI_CURSOR_RUNTIME;
		cursorSessionScopeTestUtils.reset();
	});

	function prepareCloud(context: Context) {
		return prepareCursorProviderTurn({
			params: { model, context, options: {}, stream: {} as never, partial: {} as never, sdkEventDebugRef: { current: undefined } } as never,
			cwd: "/tmp/project",
			resolvedApiKey: "test-key",
			sdkEventDebug: undefined,
			throwIfAborted: () => {},
			resolvedConfig: resolveCursorProviderTurnConfig("/tmp/project"),
		});
	}

	it("refuses an advisor request before any cloud agent exists", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		process.env.PI_CURSOR_RUNTIME = "cloud";
		await expect(prepareCloud(advisorTurn(["read", "grep", "glob"]))).rejects.toThrow(
			"Cursor cloud agents cannot serve an omp advisor",
		);
		// Other requests still reach the cloud preflight, which stops here without an SDK call.
		// A summarizer is not refused: the SDK cannot restrict it there either, and refusing
		// it would stop the main session's compaction on the cloud runtime.
		await expect(prepareCloud(mainTurn)).rejects.toThrow("Cursor cloud runtime is not ready to start");
		await expect(prepareCloud(summarizerTurn)).rejects.toThrow("Cursor cloud runtime is not ready to start");
	});
});

describe("local prepare", () => {
	// Local prepare patches global setTimeout and sets the bundled ripgrep path process-wide.
	const ripgrepPath = process.env.CURSOR_RIPGREP_PATH;
	afterEach(async () => {
		await disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.reset();
		restoreCursorMcpToolTimeoutOverride();
		if (ripgrepPath === undefined) delete process.env.CURSOR_RIPGREP_PATH;
		else process.env.CURSOR_RIPGREP_PATH = ripgrepPath;
	});

	async function prepareLocal(context: Context, route: { oneShot: boolean; conversationId: string; mainConversation: boolean }) {
		// Under Bun the provider's lazy `import("@cursor/sdk")` returns this same module.
		const create = vi.spyOn(Agent, "create").mockResolvedValue({ agentId: "agent-local", [Symbol.asyncDispose]: async () => {} } as never);
		try {
			const prepared = await prepareCursorProviderTurn({
				params: { model, context, options: {}, stream: {} as never, partial: {} as never, sdkEventDebugRef: { current: undefined } } as never,
				cwd: "/tmp/project",
				resolvedApiKey: "test-key",
				sdkEventDebug: undefined,
				throwIfAborted: () => {},
				resolvedConfig: resolveCursorProviderTurnConfig("/tmp/project"),
				...route,
			});
			prepared.restoreCursorSdkOutputFilter();
			await prepared.lifecycle.dispose();
			return { createOptions: create.mock.calls[0]?.[0], promptText: prepared.payload.text };
		} finally {
			create.mockRestore();
		}
	}

	it("creates an advisor's agent with its allowlist and tells the model exactly those tools", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		const { createOptions, promptText } = await prepareLocal(advisorTurn(["read", "grep", "glob", "bash"]), {
			oneShot: false,
			conversationId: ADVISOR_SESSION_ID,
			mainConversation: false,
		});
		expect(createOptions).toMatchObject({ tools: ["read", "grep", "glob"] });
		expect(promptText).toContain("- Cursor built-in tools: read, grep, glob only.");
	});

	it("creates a summarizer's one-shot agent with no built-in tools", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		const { createOptions, promptText } = await prepareLocal(summarizerTurn, {
			oneShot: true,
			conversationId: ADVISOR_SESSION_ID,
			mainConversation: false,
		});
		expect(createOptions).toMatchObject({ tools: [] });
		expect(promptText).toContain("- Cursor built-in tools: none; reply with text only.");
	});
});

describe("installed @cursor/sdk built-in tool restriction contract", () => {
	it("cannot restrict a cloud agent's built-in tools", async () => {
		const attempt = (async () =>
			Agent.create({ apiKey: "crsr_contract_test", cloud: { repos: [{ url: "https://github.com/example/example" }] }, tools: ["read"] }))();
		await expect(attempt).rejects.toThrow("`tools` is not supported for cloud agents yet");
	});

	it("declares every name the advisor allowlist uses as a built-in tool name", () => {
		// `ToolName` also admits any string, so a renamed tool still compiles; Agent.create
		// would then reject every advisor agent at runtime.
		const declared = readFileSync(join(REPO, "node_modules/@cursor/sdk/dist/esm/options.d.ts"), "utf8").match(
			/export type ToolName = ([^;]+);/,
		)?.[1];
		const allowlist = getCursorBuiltInToolAllowlist(advisorTurn(["read", "grep", "glob", "ls", "find", "search"])) ?? [];
		expect(allowlist.length).toBeGreaterThan(0);
		for (const name of allowlist) expect(declared).toContain(`"${name}"`);
	});

	it("sends a local agent's restriction with every run it starts", () => {
		const bundle = readFileSync(join(REPO, "node_modules/@cursor/sdk/dist/bundled/index.js"), "utf8");
		// Each run copies the allowlist from the agent's options, so a pooled advisor agent
		// keeps it on every send...
		expect(bundle).toContain("...this.options.allowedProtoTools!==void 0?{allowedTools:this.options.allowedProtoTools}:{}");
		// ...and it reaches Cursor's backend, which offers the model only the listed tools.
		expect(bundle).toContain('"x-cursor-agent-allowed-tools"');
	});
});
