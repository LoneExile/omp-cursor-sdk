import { beforeEach, describe, expect, it } from "vitest";
import {
	__testUtils,
	persistCursorSessionAgentResumeHandle,
	registerCursorSessionAgentResume,
} from "../src/cursor-session-agent-resume.js";

function createSessionManager() {
	return {
		getBranch: () => [],
		getEntries: () => [],
		getSessionFile: () => "/tmp/cursor-resume-test.jsonl",
		getSessionId: () => "cursor-resume-test",
	};
}

function createHandle(agentId: string) {
	return {
		agentId,
		runtime: "local",
		poolKey: "pool",
		sendState: {
			bootstrapped: true,
			contextFingerprint: "fingerprint",
			incrementalSendCount: 0,
		},
		storeIdentity: {},
	};
}

describe("Cursor session resume during compaction", () => {
	beforeEach(() => __testUtils.reset());

	function registerHandlers(appended: unknown[]) {
		const handlers = new Map<string, Function>();
		registerCursorSessionAgentResume({
			appendEntry: (...args: unknown[]) => appended.push(args),
			on: (name: string, handler: Function) => handlers.set(name, handler),
		} as any);
		handlers.get("session_start")?.({}, { cwd: "/tmp", sessionManager: createSessionManager() });
		return handlers;
	}

	it("drops a pooled handle still pending when session_compact lands", () => {
		const appended: unknown[] = [];
		const handlers = registerHandlers(appended);

		persistCursorSessionAgentResumeHandle(createHandle("agent-before-compaction") as any);
		handlers.get("session_compact")?.(
			{ compactionEntry: { id: "compact", type: "compaction", summary: "summary" } },
			{ sessionManager: createSessionManager() },
		);
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });
		expect(appended).toHaveLength(0);

		persistCursorSessionAgentResumeHandle(createHandle("agent-normal") as any);
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });
		expect(appended).toEqual([[expect.any(String), expect.objectContaining({ agentId: "agent-normal" })]]);
	});

	// Only pooled sends persist a handle; the summarizer's one-shot agent never does
	// (cursor-one-shot-request.ts), so nothing gates a pooled turn's handle.
	it("persists a pooled turn's handle at its turn_end", () => {
		const appended: unknown[] = [];
		const handlers = registerHandlers(appended);

		handlers.get("turn_start")?.({}, { sessionManager: createSessionManager() });
		persistCursorSessionAgentResumeHandle(createHandle("agent-pooled-turn") as any);
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });

		expect(appended).toEqual([[expect.any(String), expect.objectContaining({ agentId: "agent-pooled-turn" })]]);
	});
});
