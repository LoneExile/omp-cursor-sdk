import { describe, expect, it } from "vitest";
import {
	__testUtils,
	persistCursorSessionAgentResumeHandle,
	registerCursorSessionAgentResume,
	suppressCursorSessionAgentResumeHandlePersist,
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
	function registerHandlers(appended: unknown[]) {
		const handlers = new Map<string, Function>();
		registerCursorSessionAgentResume({
			appendEntry: (...args: unknown[]) => appended.push(args),
			on: (name: string, handler: Function) => handlers.set(name, handler),
		} as any);
		handlers.get("session_start")?.({}, { cwd: "/tmp", sessionManager: createSessionManager() });
		return handlers;
	}

	it("does not persist a summarizer handle while suppressed", () => {
		const appended: unknown[] = [];
		const handlers = registerHandlers(appended);

		suppressCursorSessionAgentResumeHandlePersist();
		persistCursorSessionAgentResumeHandle(createHandle("agent-summary") as any);
		expect(__testUtils.pendingResumeAgentId()).toBeUndefined();
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });

		expect(appended).toHaveLength(0);
		expect(__testUtils.isResumeHandlePersistSuppressed()).toBe(false);
	});

	it("resumes normal persistence after session_compact", () => {
		const appended: unknown[] = [];
		const handlers = registerHandlers(appended);

		suppressCursorSessionAgentResumeHandlePersist();
		handlers.get("session_compact")?.(
			{ compactionEntry: { id: "compact", type: "compaction", summary: "summary" } },
			{ sessionManager: createSessionManager() },
		);
		persistCursorSessionAgentResumeHandle(createHandle("agent-normal") as any);
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });

		expect(appended).toHaveLength(1);
	});

	it("clears suppression at the next turn_end when compaction fails or is cancelled", () => {
		const appended: unknown[] = [];
		const handlers = registerHandlers(appended);

		suppressCursorSessionAgentResumeHandlePersist();
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });
		persistCursorSessionAgentResumeHandle(createHandle("agent-after-failed-compaction") as any);
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });

		expect(appended).toHaveLength(1);
		expect(__testUtils.isResumeHandlePersistSuppressed()).toBe(false);
	});

	// omp 18.3.4 runs the summarizer through the session side-stream (session-maintenance
	// compact() completeImpl -> sideStreamFn), outside the agent loop: no turn_start/turn_end.
	// A failed or cancelled compaction emits no session_compact, so the next event is the
	// next normal turn's turn_start.
	it("persists the next normal turn after a failed compaction", () => {
		const appended: unknown[] = [];
		const handlers = registerHandlers(appended);

		suppressCursorSessionAgentResumeHandlePersist();
		persistCursorSessionAgentResumeHandle(createHandle("agent-summary") as any);
		handlers.get("turn_start")?.({}, { sessionManager: createSessionManager() });
		persistCursorSessionAgentResumeHandle(createHandle("agent-next-turn") as any);
		handlers.get("turn_end")?.({}, { sessionManager: createSessionManager() });

		expect(appended).toHaveLength(1);
		expect(appended[0]).toEqual([expect.any(String), expect.objectContaining({ agentId: "agent-next-turn" })]);
	});
});
