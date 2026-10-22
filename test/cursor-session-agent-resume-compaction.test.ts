import type { ModelSelection } from "@cursor/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import {
	__testUtils,
	getMatchingCursorSessionAgentResumeHandle,
	persistCursorSessionAgentResumeHandle,
	registerCursorSessionAgentResume,
} from "../src/cursor-session-agent-resume.js";
import { __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";

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

// A resume handle matches the session agent's pool key by exact string, and the key embeds JSON.stringify of the model
// selection. @cursor/sdk 1.0.40 carries Max Mode as `ModelSelection.maxMode`, where the 1.0.34 plugin sent a `max_mode`
// param, so a handle recorded before the upgrade with Max Mode on stops matching once: the session starts a fresh agent
// from its own transcript (the one-time resume fallback), and later handles carry the new key.
describe("Cursor session resume handles across the Max Mode selection change", () => {
	const scopeKey = "/tmp/sessions/max-mode.jsonl";
	const cwd = "/tmp/project";
	const baseParams = { apiKey: "test-key", agentMode: "agent" as const, cwd };
	const params = [
		{ id: "context", value: "500k" },
		{ id: "reasoning_effort", value: "high" },
	];
	const nativeMaxMode: ModelSelection = { id: "grok-4.7", params, maxMode: true };
	const legacyMaxMode: ModelSelection = { id: "grok-4.7", params: [...params, { id: "max_mode", value: "true" }] };
	const maxModeOff: ModelSelection = { id: "grok-4.7", params };

	/** The model part of the key: the fourth NUL-separated segment, after scope, conversation and cwd. */
	function poolKeyFor(modelSelection: ModelSelection): { key: string; model: string } {
		const key = sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, { ...baseParams, modelSelection });
		return { key, model: key.split("\0")[3]! };
	}

	function recordHandle(poolKey: string): void {
		__testUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			sessionId: undefined,
			cwd,
			repoRoot: undefined,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd,
				poolKey,
				branchPathHash: __testUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
				createdAt: "2026-10-22T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			},
		});
	}

	beforeEach(() => __testUtils.reset());

	it("keys a Max Mode selection by the native maxMode field, not a max_mode param", () => {
		expect(poolKeyFor(nativeMaxMode).model).toBe(
			'{"id":"grok-4.7","params":[{"id":"context","value":"500k"},{"id":"reasoning_effort","value":"high"}],"maxMode":true}',
		);
		expect(poolKeyFor(nativeMaxMode).model).not.toContain("max_mode");
		// The pre-upgrade form carried Max Mode inside params.
		expect(poolKeyFor(legacyMaxMode).model).toBe(
			'{"id":"grok-4.7","params":[{"id":"context","value":"500k"},{"id":"reasoning_effort","value":"high"},{"id":"max_mode","value":"true"}]}',
		);
		expect(poolKeyFor(nativeMaxMode).key).not.toBe(poolKeyFor(legacyMaxMode).key);
	});

	it("leaves the key of a selection without Max Mode as it was", () => {
		expect(poolKeyFor(maxModeOff).model).toBe(
			'{"id":"grok-4.7","params":[{"id":"context","value":"500k"},{"id":"reasoning_effort","value":"high"}]}',
		);
	});

	it("does not resume a handle recorded under the legacy max_mode key, and resumes one recorded under the native key", () => {
		const nativeKey = poolKeyFor(nativeMaxMode).key;

		recordHandle(poolKeyFor(legacyMaxMode).key);
		expect(getMatchingCursorSessionAgentResumeHandle(nativeKey)).toBeUndefined();

		recordHandle(nativeKey);
		expect(getMatchingCursorSessionAgentResumeHandle(nativeKey)).toMatchObject({ agentId: "agent-recorded" });

		// Max Mode off was never touched: a handle recorded without it keeps matching.
		recordHandle(poolKeyFor(maxModeOff).key);
		expect(getMatchingCursorSessionAgentResumeHandle(poolKeyFor(maxModeOff).key)).toMatchObject({ agentId: "agent-recorded" });
	});
});
