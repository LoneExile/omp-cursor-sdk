import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cursorExtension from "../src/index.js";
import { getRegisteredCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";
import type { CursorPiToolBridgeRegistry } from "../src/cursor-pi-tool-bridge-server.js";
import {
	resolveCursorRequestBinding,
	runInCursorSessionBinding,
	__testUtils as bindingTestUtils,
} from "../src/cursor-session-binding.js";
import {
	acquireSessionCursorAgent,
	disposeAllSessionCursorAgents,
	sessionAgentEntryKey,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { getCursorSessionScopeKey } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";

sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async () => ({ dispose: async () => {} }) as never,
});

const PARENT = { id: "01a0e2f0-0000-7000-8000-00000000a001", file: "/tmp/sessions/parent.jsonl" };
const CHILD = { id: "01a0e2f0-0000-7000-8000-00000000c001", file: "/tmp/sessions/child.jsonl" };

function sessionContext(session: { id: string; file: string }, kind: "main" | "sub") {
	return {
		cwd: "/tmp/project",
		agent: { kind, id: kind === "main" ? "Main" : "0-Task", name: kind === "main" ? "main" : "task", depth: kind === "main" ? 0 : 1 },
		sessionManager: {
			getSessionId: () => session.id,
			getSessionFile: () => session.file,
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
	} as never;
}

/** A registration of the extension, as omp creates one per session (root or re-bound child). */
async function registerSession(session: { id: string; file: string }, kind: "main" | "sub") {
	const pi = createExtensionPi([createTestToolInfo("custom_read")]);
	pi.getActiveTools.mockImplementation(() => ["custom_read"]);
	await cursorExtension(pi);
	await pi.runSessionStart(sessionContext(session, kind));
	const providerSessionState = new Map();
	// omp's provider calls carry the session's provider session id and state store.
	const binding = resolveCursorRequestBinding({ sessionId: session.id, providerSessionState });
	const inSession = <T>(body: () => T): T => runInCursorSessionBinding(binding, body);
	return { pi, binding, providerSessionState, inSession };
}

function createAgentMock(agentId: string) {
	return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
}

describe("per-session state across in-process subagent binds", () => {
	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingTestUtils.reset();
		await resetIndexExtensionTestState();
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "1";
	});

	afterEach(async () => {
		delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
		await disposeAllSessionCursorAgents();
		bindingTestUtils.reset();
	});

	it("leaves the parent's bridge, tracked tool call, scope and pooled agent alone when a child binds and starts", async () => {
		const parent = await registerSession(PARENT, "main");
		const parentAgent = createAgentMock("agent-parent");
		const parentLease = await parent.inSession(() =>
			acquireSessionCursorAgent({
				apiKey: "test-key",
				agentMode: "agent",
				cwd: "/tmp/project",
				modelSelection: { id: "composer-2.5" },
				conversationId: PARENT.id,
				createAgent: vi.fn().mockResolvedValue(parentAgent) as never,
			}),
		);
		let finishParentRun!: () => void;
		parentLease.trackRunCompletion(new Promise<void>((resolve) => { finishParentRun = resolve; }));
		const parentBridge = parent.inSession(() => getRegisteredCursorPiToolBridge()) as CursorPiToolBridgeRegistry;
		const runs = [await parentBridge.createRun(), await parentBridge.createRun()];
		const abortParentCall = vi.fn();
		// The parent's bridged pi__task call, running while the child session exists.
		parentBridge.abortTracker.track("pi-bridge-task-call", { abort: abortParentCall, cancelPending: vi.fn() });
		// The pooled agent's bridge run plus the two runs above.
		expect(parentBridge.getEndpointCount()).toBe(3);

		// task/executor.ts: the child re-binds the parent's prepared factory, then emits session_start.
		const child = await registerSession(CHILD, "sub");
		await child.pi.runTurnEnd();
		await child.pi.runSessionShutdown();

		expect(abortParentCall).not.toHaveBeenCalled();
		expect(parentBridge.abortTracker.getActiveCount()).toBe(1);
		expect(parentBridge.getEndpointCount()).toBe(3);
		expect(parent.inSession(() => getRegisteredCursorPiToolBridge())).toBe(parentBridge);
		expect(child.inSession(() => getRegisteredCursorPiToolBridge())).not.toBe(parentBridge);
		expect(parent.inSession(() => getCursorSessionScopeKey())).toBe(PARENT.file);
		expect(child.inSession(() => getCursorSessionScopeKey())).toBe(CHILD.file);
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(PARENT.file, PARENT.id))?.status).toBe("busy");
		expect(parentAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
		// The parent's later provider calls still resolve to the parent's session.
		expect(resolveCursorRequestBinding({ sessionId: PARENT.id, providerSessionState: parent.providerSessionState })).toBe(parent.binding);
		expect(resolveCursorRequestBinding({ sessionId: PARENT.id, providerSessionState: new Map() })).toBe(parent.binding);

		finishParentRun();
		for (const run of runs) await run.dispose();
	});

	it("cleans a replaced session's bridge on its own session_shutdown (reload)", async () => {
		// A reload imports a new module instance (legacy-pi-compat.ts loadLegacyPiModule);
		// the old instance's session is disposed and its session_shutdown runs.
		const old = await registerSession(PARENT, "main");
		const oldBridge = old.inSession(() => getRegisteredCursorPiToolBridge()) as CursorPiToolBridgeRegistry;
		await oldBridge.createRun();
		const abortOldCall = vi.fn();
		oldBridge.abortTracker.track("pi-bridge-read-call", { abort: abortOldCall, cancelPending: vi.fn() });

		await old.pi.runSessionShutdown();

		expect(abortOldCall).toHaveBeenCalledTimes(1);
		expect(oldBridge.abortTracker.getActiveCount()).toBe(0);
		expect(oldBridge.getEndpointCount()).toBe(0);
		expect(bindingTestUtils.liveBindingCount()).toBe(0);
	});
});
