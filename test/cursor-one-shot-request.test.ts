import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { generateSummary, generateHandoffFromContext } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import { isCursorOneShotRequest } from "../src/cursor-one-shot-request.js";
import {
	acquireSessionCursorAgent,
	createOneShotCursorAgent,
	disposeAllSessionCursorAgents,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";

// SDK sqlite stores replaced with in-memory fakes; the test never touches the real SDK state root.
const storeDisposals: string[] = [];
sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async ({ stateRoot }) => ({ dispose: async () => { storeDisposals.push(stateRoot); } }) as never,
});

const SCOPE = "/tmp/sessions/one-shot.jsonl";

const model = {
	id: "composer-2.5",
	name: "Composer 2.5",
	api: "cursor-sdk",
	provider: "cursor-sdk",
	baseUrl: "https://cursor.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
} as unknown as Model;

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk",
		provider: "cursor-sdk",
		model: "composer-2.5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const sessionSystemPrompt = ["omp system prompt"];
const userTurn: Context = { systemPrompt: sessionSystemPrompt, messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
// A tool-result continuation of the pooled agent's live run, as omp sends it after a
// mid-run compaction between provider calls (session-maintenance.ts).
const toolResultContinuation: Context = {
	systemPrompt: sessionSystemPrompt,
	messages: [
		...userTurn.messages,
		{ ...reply(""), content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "parser.ts" } }], stopReason: "toolUse" },
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "source" }], isError: false, timestamp: 3 },
	],
};

// Agent-loop turns carry the session's provider state store and provider session id
// (pi-agent-core agent.ts); session-maintenance.ts hands the same pair to the summarizer.
const sessionOptions = { sessionId: "01a0e261-2b80-7000", providerSessionState: new Map() };

/** The request omp's own summarizer sends, captured at the provider boundary. */
async function captureHostSummarizerRequest(): Promise<{ context: Context; options: SimpleStreamOptions }> {
	let captured: { context: Context; options: SimpleStreamOptions } | undefined;
	await generateSummary(
		[{ role: "user", content: "Refactor the parser", timestamp: 1 }, reply("Parser refactored.")],
		model,
		16000,
		"test-key",
		undefined,
		undefined,
		undefined,
		{
			...sessionOptions,
			completeImpl: async (_model, context, options) => {
				captured = { context, options };
				return reply("## Goal\nRefactor the parser.");
			},
		},
	);
	if (!captured) throw new Error("generateSummary sent no request");
	return captured;
}

describe("one-shot request identification", () => {
	it("recognizes the host summarizer request and nothing that continues the conversation", async () => {
		const summarizer = await captureHostSummarizerRequest();
		expect(summarizer.options.providerSessionState).toBe(sessionOptions.providerSessionState);
		expect(isCursorOneShotRequest(summarizer.context, summarizer.options)).toBe(true);

		expect(isCursorOneShotRequest(userTurn, sessionOptions)).toBe(false);
		expect(isCursorOneShotRequest(toolResultContinuation, sessionOptions)).toBe(false);
		// Only the exact summarizer prompt counts, not a session prompt that merely contains it.
		expect(
			isCursorOneShotRequest({ systemPrompt: [...sessionSystemPrompt, ...summarizer.context.systemPrompt!] }, sessionOptions),
		).toBe(false);
	});

	it("recognizes omp side requests such as the handoff document by their session id", async () => {
		// session-handoff.ts builds the handoff context like a live turn (session system
		// prompt, full history, trailing handoff prompt) and routes it on `<session>:side:<id>`.
		const handoffContext: Context = {
			systemPrompt: sessionSystemPrompt,
			messages: [...toolResultContinuation.messages, { role: "user", content: "Write a handoff document.", timestamp: 4 }],
		};
		let requestOptions: SimpleStreamOptions | undefined;
		await generateHandoffFromContext(handoffContext, model, {
			streamOptions: { sessionId: "01a0e261-2b80-7000:side:7390", providerSessionState: sessionOptions.providerSessionState },
			completeImpl: async (_model, _ctx, options) => {
				requestOptions = options;
				return reply("# Handoff");
			},
		});
		expect(isCursorOneShotRequest(handoffContext, requestOptions)).toBe(true);
		expect(requestOptions?.providerSessionState).toBe(sessionOptions.providerSessionState);
		expect(
			isCursorOneShotRequest(userTurn, { ...sessionOptions, sessionId: "01a0e261-2b80-7000:side:conversation:btw-1" }),
		).toBe(true);
	});
});

describe("one-shot agent", () => {
	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		storeDisposals.length = 0;
	});

	afterEach(() => {
		cursorSessionScopeTestUtils.reset();
	});

	it("is created outside the pool, leaves the pooled conversation untouched and disposes once", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		const pooled = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent: vi.fn().mockResolvedValue({ agentId: "agent-pooled", [Symbol.asyncDispose]: vi.fn() }) as never,
		});
		pooled.commitSend(userTurn, true);
		const pooledEntry = sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE);
		const oneShotAgent = { agentId: "agent-one-shot", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };

		const oneShot = await createOneShotCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent: vi.fn().mockResolvedValue(oneShotAgent) as never,
		});
		oneShot.commitSend((await captureHostSummarizerRequest()).context, true);

		expect(oneShot.agent).toBe(oneShotAgent);
		expect(oneShot.bridgeRun).toBeUndefined();
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE)).toBe(pooledEntry);
		expect(pooled.sendState.contextFingerprint).toBe(computeCursorContextFingerprint(userTurn));
		await Promise.all([oneShot.dispose(), oneShot.dispose()]);
		expect(oneShotAgent[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
		expect(storeDisposals).toHaveLength(1);
	});
});
