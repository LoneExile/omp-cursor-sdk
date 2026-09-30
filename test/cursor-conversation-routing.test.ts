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
import { renderInbandToolPrompt } from "@oh-my-pi/pi-ai/dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import { cursorLiveRuns, drainExistingCursorLiveRunBeforeSend } from "../src/cursor-provider-live-run-drain.js";
import {
	classifyCursorRequestRoute,
	getCursorConversationId,
	isCursorAdvisorRequest,
	isCursorOneShotRequest,
	registerCursorConversationTracking,
	__testUtils as conversationTestUtils,
} from "../src/cursor-one-shot-request.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	disposeAllSessionCursorAgents,
	isOneShotCursorAgentLease,
	sessionAgentEntryKey,
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
const ADVISOR_SESSION_ID = "01a0e2a0-0000-7000-8000-0000000000ad";
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

function advisorParams(agentId: string) {
	return { ...acquireParams({ id: "composer-2.5" }, agentId, ADVISOR_SESSION_ID), mainConversation: false };
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

	it("recognizes an advisor whose tools omp moved in-band under an owned dialect", async () => {
		// pi-agent-core agent-loop.ts prepareProviderCall: an owned dialect (`PI_DIALECT` or the
		// agent's `dialect`) appends the tool catalog to the system prompt and sends no `tools`.
		const adviseTool = { name: "advise", label: "Advise", description: "Send advice", parameters: {}, execute: async () => ({ content: [] }) };
		const agent = new Agent({
			initialState: { systemPrompt: ["advisor prompt"], model, tools: [adviseTool as never], messages: [] },
			sessionId: ADVISOR_SESSION_ID,
			providerSessionState: new Map(),
			dialect: "glm",
			getApiKey: () => "test-key",
		});
		await agent.prompt("Review the diff");
		await agent.waitForIdle();
		const turn = captured.at(-1)!;
		expect(turn.context.tools).toBeUndefined();
		expect(isCursorAdvisorRequest(turn.context)).toBe(true);
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
		resumeTestUtils.reset();
	});

	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
	});

	const mainEntry = () => sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(SCOPE, MAIN_SESSION_ID));

	it("does not supersede a conversation agent that is still being created", async () => {
		const conversation = acquireSessionCursorAgent(acquireParams({ id: "claude-opus-5", params: [{ id: "effort", value: "high" }] }, "agent-conv"));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const other = acquireSessionCursorAgent(acquireParams({ id: "claude-opus-5", params: [{ id: "thinking", value: "false" }] }, "agent-title"));

		const [conversationLease, otherLease] = await Promise.all([conversation, other]);
		expect(conversationLease.agent.agentId).toBe("agent-conv");
		expect(isOneShotCursorAgentLease(conversationLease)).toBe(false);
		expect(isOneShotCursorAgentLease(otherLease)).toBe(true);
		expect(mainEntry()?.poolKey).toBe(conversationLease.poolKey);
		if (isOneShotCursorAgentLease(otherLease)) await otherLease.dispose();
	});

	it("gives an advisor loop its own pooled agent while the main run is in flight", async () => {
		const conversationLease = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-conv"));
		let finishRun!: () => void;
		conversationLease.trackRunCompletion(new Promise<void>((resolve) => { finishRun = resolve; }));
		const conversationAgent = conversationLease.agent as unknown as ReturnType<typeof createAgentMock>;

		const advisorLease = await acquireSessionCursorAgent(advisorParams("agent-advisor"));
		expect(isOneShotCursorAgentLease(advisorLease)).toBe(false);
		expect(advisorLease.agent.agentId).toBe("agent-advisor");
		expect(conversationAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
		expect(mainEntry()?.status).toBe("busy");

		finishRun();
	});

	it("keeps a main turn pooled while an advisor run is in flight", async () => {
		await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-main"));
		const advisorLease = await acquireSessionCursorAgent(advisorParams("agent-advisor"));
		expect(isOneShotCursorAgentLease(advisorLease)).toBe(false);
		let finishAdvisorRun!: () => void;
		advisorLease.trackRunCompletion(new Promise<void>((resolve) => { finishAdvisorRun = resolve; }));

		const mainTurn = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-unused"));
		expect(isOneShotCursorAgentLease(mainTurn)).toBe(false);
		expect(mainTurn.agent.agentId).toBe("agent-main");
		finishAdvisorRun();
	});

	it("keeps the main agent across an advisor acquire between turns", async () => {
		const turn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
		const first = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-main"));
		first.commitSend(turn, true);
		const mainAgent = first.agent as unknown as ReturnType<typeof createAgentMock>;

		const advisorLease = await acquireSessionCursorAgent(advisorParams("agent-advisor"));
		advisorLease.commitSend(turn, true);

		const next = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-unused"));
		expect(next.agent).toBe(first.agent);
		expect(mainAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
		expect(next.sendState.contextFingerprint).toBe(computeCursorContextFingerprint(turn));
	});

	// Pinned to the key 0.4.1 built for these params: persisted local-resume handles match the
	// pool key by exact string, so a changed unrestricted key invalidates every saved handle.
	it("keeps the unrestricted main-conversation pool key stable across releases", async () => {
		const lease = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-golden"));
		expect(lease.poolKey).toBe(
			"/tmp/sessions/routing.jsonl\x00conversation:01a0e2a0-0000-7000-8000-000000000001\x00/tmp/project\x00{\"id\":\"composer-2.5\"}\x00\x00{\"autoReview\":false,\"sandboxEnabled\":false}\x00http1:default\x0062af8704764faf8e\x00bridge:absent",
		);
	});

	it("persists a local-resume handle only for the main conversation", async () => {
		const turn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
		const advisorLease = await acquireSessionCursorAgent({ ...advisorParams("agent-advisor"), localResume: true });
		advisorLease.commitSend(turn, true);
		expect(resumeTestUtils.pendingResumeAgentId()).toBeUndefined();

		const mainLease = await acquireSessionCursorAgent({ ...acquireParams({ id: "composer-2.5" }, "agent-main"), localResume: true });
		mainLease.commitSend(turn, true);
		expect(resumeTestUtils.pendingResumeAgentId()).toBe("agent-main");
	});

	it("keeps the pooled send state when a same-key utility request is routed one-shot", async () => {
		const turn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
		const conversationLease = await acquireSessionCursorAgent(acquireParams({ id: "composer-2.5" }, "agent-conv"));
		conversationLease.commitSend(turn, true);
		const fingerprint = conversationLease.sendState.contextFingerprint;

		const title: Context = { systemPrompt: ["Generate a short title."], messages: [{ role: "user", content: "Refactor the parser", timestamp: 2 }] };
		expect(isCursorOneShotRequest(title, { sessionId: "01a0e2a0-0000-7000-8000-00000000beef" })).toBe(true);
		expect(mainEntry()?.sendState.contextFingerprint).toBe(fingerprint);
		expect(fingerprint).toBe(computeCursorContextFingerprint(turn));
	});
});

describe("main conversation tracking", () => {
	const turn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
	// session-advisors.ts: advisor loops run `[adviseTool, ...tools]` over the session's own
	// store, under a provider session id of their own.
	const advisorTurn: Context = {
		systemPrompt: ["advisor prompt"],
		messages: [{ role: "user", content: "Review the diff", timestamp: 1 }],
		tools: [
			{ name: "advise", description: "Send advice", parameters: {} as never },
			{ name: "read", description: "Read a file", parameters: {} as never },
		],
	};
	const FRESH_SESSION_ID = "01a0e2a0-0000-7000-8000-00000000f7e5";
	const FRESH_ADVISOR_SESSION_ID = "01a0e2a0-0000-7000-8000-00000000f7ad";

	function startSession(sessionId: string) {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		registerCursorConversationTracking({ on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler) } as never);
		handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => sessionId } });
		return { beforeAgentStart: () => handlers.get("before_agent_start")?.({}, {}) };
	}

	beforeEach(() => conversationTestUtils.reset());

	it("tells the main loop from an advisor loop and an auto-learn capture", () => {
		const session = startSession(MAIN_SESSION_ID);
		const store = new Map();
		session.beforeAgentStart();
		expect(classifyCursorRequestRoute(turn, { sessionId: MAIN_SESSION_ID, providerSessionState: store })).toEqual({
			oneShot: false,
			conversationId: MAIN_SESSION_ID,
			mainConversation: true,
		});
		expect(classifyCursorRequestRoute(advisorTurn, { sessionId: ADVISOR_SESSION_ID, providerSessionState: store })).toEqual({
			oneShot: false,
			conversationId: ADVISOR_SESSION_ID,
			mainConversation: false,
		});
		// sdk.ts createAutoLearnCaptureRunner: a store and id of its own.
		expect(classifyCursorRequestRoute(turn, { sessionId: "01a0e2a0-0000-7000-8000-0000000c0de0", providerSessionState: new Map() })).toMatchObject({
			oneShot: true,
			mainConversation: false,
		});
	});

	it("never lets an advisor take the main conversation while the main loop runs on another provider", () => {
		const session = startSession(MAIN_SESSION_ID);
		const store = new Map();
		// Every prompt arms the tracker; no pooled main-loop request ever disarms it.
		session.beforeAgentStart();
		expect(classifyCursorRequestRoute(advisorTurn, { sessionId: ADVISOR_SESSION_ID, providerSessionState: store }).mainConversation).toBe(false);
		session.beforeAgentStart();
		expect(classifyCursorRequestRoute(advisorTurn, { sessionId: ADVISOR_SESSION_ID, providerSessionState: store }).mainConversation).toBe(false);
		// The user switches the main loop to a Cursor model.
		expect(classifyCursorRequestRoute(turn, { sessionId: MAIN_SESSION_ID, providerSessionState: store }).mainConversation).toBe(true);
	});

	it("never lets an advisor take the main conversation when omp sends its tools in-band", () => {
		const session = startSession(MAIN_SESSION_ID);
		const store = new Map();
		session.beforeAgentStart();
		const inbandAdvisorTurn: Context = {
			...advisorTurn,
			systemPrompt: [...(advisorTurn.systemPrompt ?? []), renderInbandToolPrompt(advisorTurn.tools ?? [], "glm")],
			tools: undefined,
		};
		expect(classifyCursorRequestRoute(inbandAdvisorTurn, { sessionId: ADVISOR_SESSION_ID, providerSessionState: store }).mainConversation).toBe(false);
		expect(classifyCursorRequestRoute(turn, { sessionId: MAIN_SESSION_ID, providerSessionState: store }).mainConversation).toBe(true);
	});

	it("follows the main conversation to its /fresh id when the advisors' new ids arrive first", () => {
		const session = startSession(MAIN_SESSION_ID);
		const store = new Map();
		session.beforeAgentStart();
		classifyCursorRequestRoute(turn, { sessionId: MAIN_SESSION_ID, providerSessionState: store });
		classifyCursorRequestRoute(advisorTurn, { sessionId: ADVISOR_SESSION_ID, providerSessionState: store });

		// agent-session.ts freshSession: a new provider session id and the same store; the
		// advisors get new ids too (session-advisors.ts refreshProviderIdentity) and can be
		// first in the window before the main loop's first provider call.
		session.beforeAgentStart();
		expect(classifyCursorRequestRoute(advisorTurn, { sessionId: FRESH_ADVISOR_SESSION_ID, providerSessionState: store }).mainConversation).toBe(false);
		expect(classifyCursorRequestRoute(turn, { sessionId: FRESH_SESSION_ID, providerSessionState: store }).mainConversation).toBe(true);
		expect(classifyCursorRequestRoute(turn, { sessionId: MAIN_SESSION_ID, providerSessionState: store }).mainConversation).toBe(false);

		session.beforeAgentStart();
		expect(classifyCursorRequestRoute(advisorTurn, { sessionId: FRESH_ADVISOR_SESSION_ID, providerSessionState: store }).mainConversation).toBe(false);
		expect(classifyCursorRequestRoute(turn, { sessionId: FRESH_SESSION_ID, providerSessionState: store }).mainConversation).toBe(true);
	});
});

describe("pre-send live-run drain", () => {
	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
	});

	it("leaves another conversation's live run alone", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		const run = cursorLiveRuns.start({ id: "conversation-run", agent: {} as never, conversationId: MAIN_SESSION_ID, promptInputTokens: 0 });
		const advisorTurn: Context = { systemPrompt: ["advisor prompt"], messages: [{ role: "user", content: "Review the diff", timestamp: 1 }] };
		const stream = { push() {} } as never;
		const outcome = await drainExistingCursorLiveRunBeforeSend(stream, reply("") as never, model, advisorTurn, undefined, undefined, ADVISOR_SESSION_ID);
		expect(outcome).toBe("continue_send");
		expect(cursorLiveRuns.getActiveForScope(SCOPE)).toBe(run);
		expect(run.chainUserInputAfterCompletion).toBe(false);
		await cursorLiveRuns.release(run);
	}, 2000);
});
