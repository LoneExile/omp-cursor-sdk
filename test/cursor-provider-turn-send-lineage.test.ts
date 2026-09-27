import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendCursorProviderTurn } from "../src/cursor-provider-turn-send.js";
import type { CursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";
import {
	CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE,
	registerCursorSessionAgentLineage,
	__testUtils as lineageTestUtils,
} from "../src/cursor-session-agent-lineage.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";

function registerLineage() {
	const appendEntry = vi.fn();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	registerCursorSessionAgentLineage({ appendEntry, on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler) } as never);
	cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/lineage.jsonl");
	handlers.get("session_start")?.({}, {
		cwd: "/tmp/project",
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/sessions/lineage.jsonl", getEntries: () => [] },
	});
	return appendEntry;
}

function preparedLocalSend(
	agentId: string,
	reason: "one_shot" | "incremental",
	mainConversation = reason !== "one_shot",
): CursorProviderTurnPrepareResult {
	const run = { id: `run-${agentId}`, requestId: "request-1", agentId, status: "running", cancel: vi.fn().mockResolvedValue(undefined) };
	return {
		runtimeTarget: "local",
		agent: { agentId, send: vi.fn().mockResolvedValue(run) },
		cwd: "/tmp/project",
		payload: { text: "Reply with exactly OK" },
		meta: {
			sendPlan: reason === "one_shot"
				? { mode: "bootstrap", resetAgent: false, reason: "one_shot" }
				: { mode: "incremental", resetAgent: false, reason: "incremental", appendedFrom: 1 },
			prompt: { text: "Reply with exactly OK", images: [] },
			bootstrap: reason === "one_shot",
			promptInputTokens: 1,
			useNativeToolReplay: false,
			bridgeEnabled: false,
			nativeReplayId: "replay-1",
			agentMode: "agent",
			modelSelection: { id: "composer-2.5" },
			mainConversation,
		},
		runtime: { kind: "direct", turnCoordinator: {} },
		sessionAgentLease: { store: undefined },
		localForce: { value: false, source: "builtin" },
	} as unknown as CursorProviderTurnPrepareResult;
}

async function send(prepared: CursorProviderTurnPrepareResult) {
	await sendCursorProviderTurn({
		params: { options: {} } as never,
		prepared,
		sdkEventDebug: undefined,
		sdkProcessErrorGuard: { suppressAbortErrors: vi.fn() } as never,
		throwIfAborted: () => {},
	});
}

describe("Cursor agent lineage on send", () => {
	beforeEach(() => lineageTestUtils.reset());
	afterEach(() => cursorSessionScopeTestUtils.reset());

	it("records the main conversation's agent, not a one-shot or another loop's agent", async () => {
		const appendEntry = registerLineage();

		await send(preparedLocalSend("agent-one-shot-summary", "one_shot"));
		await send(preparedLocalSend("agent-advisor", "incremental", false));
		expect(appendEntry).not.toHaveBeenCalled();

		await send(preparedLocalSend("agent-pooled", "incremental"));
		expect(appendEntry).toHaveBeenCalledTimes(1);
		expect(appendEntry).toHaveBeenCalledWith(CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE, expect.objectContaining({ agentId: "agent-pooled" }));
	});
});
