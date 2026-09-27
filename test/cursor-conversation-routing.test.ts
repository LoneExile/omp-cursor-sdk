import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	chatTextBackend,
	createAssistantMessageEventStream,
	registerCustomApi,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import { cursorLiveRuns, drainExistingCursorLiveRunBeforeSend } from "../src/cursor-provider-live-run-drain.js";
import { getCursorConversationId, isCursorOneShotRequest } from "../src/cursor-one-shot-request.js";
import {
	acquireSessionCursorAgent,
	disposeAllSessionCursorAgents,
	isOneShotCursorAgentLease,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";

sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async () => ({ dispose: async () => {} }) as never,
});

const SCOPE = "/tmp/sessions/routing.jsonl";
const MAIN_SESSION_ID = "01a0e2a0-0000-7000-8000-000000000001";
const CAPTURE_API = "cursor-sdk-routing-capture";

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: CAPTURE_API,
		provider: "cursor-sdk",
		model: "composer-2.5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const model = {
	id: "composer-2.5",
	name: "Composer 2.5",
	api: CAPTURE_API,
	provider: "cursor-sdk",
	baseUrl: "https://cursor.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
} as unknown as Model;

// Provider boundary: every request the host sends to this api lands here.
let captured: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
registerCustomApi(CAPTURE_API, (_model, context, options) => {
	captured.push({ context, options });
	const stream = createAssistantMessageEventStream();
	const message = reply("simple");
	queueMicrotask(() => {
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
});

function createAgentMock(agentId: string) {
	return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
}

function acquireParams(selection: { id: string; params?: Array<{ id: string; value: string }> }, agentId: string, conversationId = MAIN_SESSION_ID) {
	return {
		apiKey: "test-key",
		agentMode: "agent" as const,
		cwd: "/tmp/project",
		modelSelection: selection,
		conversationId,
		createAgent: vi.fn().mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return createAgentMock(agentId);
		}) as never,
	};
}

describe("conversation turn identification at the provider boundary", () => {
	beforeEach(() => {
		captured = [];
	});

	it("keeps the agent loop's own turns on the pool", async () => {
		// pi-agent-core agent.ts: every loop provider call carries the session's
		// providerSessionState store and the session's provider session id.
		const agent = new Agent({
			initialState: { systemPrompt: ["omp system prompt"], model, tools: [], messages: [] },
			sessionId: MAIN_SESSION_ID,
			providerSessionState: new Map(),
			getApiKey: () => "test-key",
		});
		await agent.prompt("Refactor the parser");
		await agent.waitForIdle();
		const turn = captured.at(-1)!;
		expect(isCursorOneShotRequest(turn.context, turn.options)).toBe(false);
		expect(getCursorConversationId(turn.options)).toBe(MAIN_SESSION_ID);
	});

	it("sends the auto-thinking judge one-shot although it carries the main session id", async () => {
		// pi-ai judgment/chat.ts chatTextBackend: completeSimple with the session id but no
		// providerSessionState (auto-thinking passes this.#host.sessionId(), model-controls.ts).
		const judge = chatTextBackend(model, { apiKey: "test-key", sessionId: MAIN_SESSION_ID });
		await judge.complete({ system: "Classify the request difficulty.", user: "Refactor the parser" }, {});
		const request = captured.at(-1)!;
		expect(request.options?.sessionId).toBe(MAIN_SESSION_ID);
		expect(isCursorOneShotRequest(request.context, request.options)).toBe(true);
	});

	it("sends title-style requests one-shot", () => {
		// title-generator.ts generateTitleOnline: completeSimple, TITLE_SYSTEM_PROMPT, a random
		// title session id, no providerSessionState.
		const title: Context = { systemPrompt: ["Generate a short title."], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
		expect(isCursorOneShotRequest(title, { sessionId: "01a0e2a0-0000-7000-8000-00000000beef" })).toBe(true);
	});
});

describe("session agent pool under concurrent utility requests", () => {
	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
	});

	it("does not supersede a conversation agent that is still being created", async () => {
		const conversation = acquireSessionCursorAgent(acquireParams({ id: "claude-opus-5", params: [{ id: "effort", value: "high" }] }, "agent-conv"));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const other = acquireSessionCursorAgent(acquireParams({ id: "claude-opus-5", params: [{ id: "thinking", value: "false" }] }, "agent-title"));

		const [conversationLease, otherLease] = await Promise.all([conversation, other]);
		expect(conversationLease.agent.agentId).toBe("agent-conv");
		expect(isOneShotCursorAgentLease(conversationLease)).toBe(false);
		expect(isOneShotCursorAgentLease(otherLease)).toBe(true);
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE)?.poolKey).toBe(conversationLease.poolKey);
		if (isOneShotCursorAgentLease(otherLease)) await otherLease.dispose();
	});

	it("routes a different-key request one-shot while the conversation run is in flight", async () => {
		const conversationLease = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-conv"));
		let finishRun!: () => void;
		conversationLease.trackRunCompletion(new Promise<void>((resolve) => { finishRun = resolve; }));
		const conversationAgent = conversationLease.agent as unknown as ReturnType<typeof createAgentMock>;

		const advisorLease = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-advisor", "01a0e2a0-0000-7000-8000-0000000000ad"));
		expect(isOneShotCursorAgentLease(advisorLease)).toBe(true);
		expect(conversationAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE)?.status).toBe("busy");

		finishRun();
		if (isOneShotCursorAgentLease(advisorLease)) await advisorLease.dispose();
	});

	it("keeps the pooled send state when a same-key utility request is routed one-shot", async () => {
		const turn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
		const conversationLease = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-conv"));
		conversationLease.commitSend(turn, true);
		const fingerprint = conversationLease.sendState.contextFingerprint;

		const title: Context = { systemPrompt: ["Generate a short title."], messages: [{ role: "user", content: "Refactor the parser", timestamp: 2 }] };
		expect(isCursorOneShotRequest(title, { sessionId: "01a0e2a0-0000-7000-8000-00000000beef" })).toBe(true);
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE)?.sendState.contextFingerprint).toBe(fingerprint);
		expect(fingerprint).toBe(computeCursorContextFingerprint(turn));
	});
});

describe("pre-send live-run drain", () => {
	it("leaves another conversation's live run alone", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		const run = cursorLiveRuns.start({ id: "conversation-run", agent: {} as never, conversationId: MAIN_SESSION_ID, promptInputTokens: 0 });
		const advisorTurn: Context = { systemPrompt: ["advisor prompt"], messages: [{ role: "user", content: "Review the diff", timestamp: 1 }] };
		const stream = { push() {} } as never;
		const outcome = await drainExistingCursorLiveRunBeforeSend(stream, reply("") as never, model, advisorTurn, undefined, undefined, "01a0e2a0-0000-7000-8000-0000000000ad");
		expect(outcome).toBe("continue_send");
		expect(cursorLiveRuns.getActiveForScope(SCOPE)).toBe(run);
		expect(run.chainUserInputAfterCompletion).toBe(false);
		await cursorLiveRuns.release(run);
	}, 2000);
});
