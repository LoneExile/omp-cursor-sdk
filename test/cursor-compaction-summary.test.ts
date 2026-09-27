import type { Context } from "@oh-my-pi/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import {
	isCursorOneShotRequest,
	registerCursorCompactionSummaryWindow,
	__testUtils as compactionTestUtils,
} from "../src/cursor-compaction-summary.js";
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

const SCOPE = "/tmp/sessions/compaction.jsonl";

function createEventApi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	return {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		emit: (event: string) => {
			for (const handler of handlers.get(event) ?? []) handler({ type: event }, {});
		},
		events: () => [...handlers.keys()],
	};
}

function createAgentMock(agentId: string) {
	return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
}

const userTurn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };
const followUp: Context = {
	...userTurn,
	messages: [...userTurn.messages, { role: "user", content: "Now add tests", timestamp: 3 }],
};
// Shape of omp's summarizer request (pi-agent-core compaction.ts summarizeConversationWindow).
const summarizer: Context = {
	systemPrompt: ["You are a context summarization assistant."],
	messages: [{ role: "user", content: "<conversation>\n[User]: Refactor the parser\n</conversation>", timestamp: 4 }],
};

async function seedPooledConversation() {
	cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
	const lease = await acquireSessionCursorAgent({
		apiKey: "test-key",
		agentMode: "agent",
		cwd: "/tmp/project",
		modelSelection: { id: "composer-2.5" },
		createAgent: vi.fn().mockResolvedValue(createAgentMock("agent-pooled")) as never,
	});
	lease.commitSend(userTurn, true);
	return lease;
}

describe("compaction summarizer routing", () => {
	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		storeDisposals.length = 0;
		compactionTestUtils.reset();
	});

	it("registers no session_before_compact handler", () => {
		const pi = createEventApi();
		registerCursorCompactionSummaryWindow(pi as never);
		expect(pi.events()).toEqual(["session.compacting", "session_compact", "before_agent_start"]);
	});

	it("sends the summarizer to a one-shot agent only while a compaction summary is pending", async () => {
		const pi = createEventApi();
		registerCursorCompactionSummaryWindow(pi as never);
		await seedPooledConversation();

		expect(isCursorOneShotRequest(summarizer, SCOPE)).toBe(false);
		pi.emit("session.compacting");
		expect(isCursorOneShotRequest(summarizer, SCOPE)).toBe(true);
		// A normal turn that continues the pooled conversation keeps the pool (async compaction).
		expect(isCursorOneShotRequest(followUp, SCOPE)).toBe(false);

		pi.emit("session_compact");
		expect(isCursorOneShotRequest(summarizer, SCOPE)).toBe(false);

		// Failed or cancelled compaction: the next prompt closes the window.
		pi.emit("session.compacting");
		pi.emit("before_agent_start");
		expect(isCursorOneShotRequest(summarizer, SCOPE)).toBe(false);
	});

	it("treats a summary request as one-shot when no pooled conversation exists yet", () => {
		const pi = createEventApi();
		registerCursorCompactionSummaryWindow(pi as never);
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		pi.emit("session.compacting");
		expect(isCursorOneShotRequest(summarizer, SCOPE)).toBe(true);
	});

	it("creates the one-shot agent outside the pool and disposes it once", async () => {
		const lease = await seedPooledConversation();
		const pooledEntry = sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE);
		const oneShotAgent = createAgentMock("agent-one-shot");

		const oneShot = await createOneShotCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent: vi.fn().mockResolvedValue(oneShotAgent) as never,
		});
		oneShot.commitSend(summarizer, true);

		expect(oneShot.agent).toBe(oneShotAgent);
		expect(oneShot.bridgeRun).toBeUndefined();
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(SCOPE)).toBe(pooledEntry);
		expect(lease.sendState.contextFingerprint).toBe(computeCursorContextFingerprint(userTurn));
		await Promise.all([oneShot.dispose(), oneShot.dispose()]);
		expect(oneShotAgent[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
		expect(storeDisposals).toHaveLength(1);
	});
});
