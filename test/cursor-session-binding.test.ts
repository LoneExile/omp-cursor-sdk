import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cursorExtension from "../src/index.js";
import { getRegisteredCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";
import type { CursorPiToolBridgeRegistry } from "../src/cursor-pi-tool-bridge-server.js";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { setActiveSkills } from "@oh-my-pi/pi-coding-agent";
import { classifyCursorRequestRoute } from "../src/cursor-one-shot-request.js";
import { streamCursor } from "../src/cursor-provider.js";
import {
	resolveCursorRequestBinding,
	runInCursorSessionBinding,
	type CursorSessionBinding,
	__testUtils as bindingTestUtils,
} from "../src/cursor-session-binding.js";
import {
	acquireSessionCursorAgent,
	disposeAllSessionCursorAgents,
	isOneShotCursorAgentLease,
	sessionAgentEntryKey,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { getCursorSessionScopeKey } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";
import { createExtensionTestContext } from "./helpers/context-fixtures.js";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";

sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async () => ({ dispose: async () => {} }) as never,
});

const PARENT = { id: "01a0e2f0-0000-7000-8000-00000000a001", file: "/tmp/sessions/parent.jsonl" };
const CHILD = { id: "01a0e2f0-0000-7000-8000-00000000c001", file: "/tmp/sessions/child.jsonl" };
// tan-command-controller.ts: the clone's session file sits in the parent's artifact dir, and
// its provider session id is `${parentSessionId}:tan:${Snowflake}`.
const CLONE = { id: "01a0e2f0-0000-7000-8000-0000000000c1", file: "/tmp/sessions/parent/Tan-1.jsonl" };
const CLONE_PROVIDER_SESSION_ID = `${PARENT.id}:tan:1001`;
const SECOND_CLONE = { id: "01a0e2f0-0000-7000-8000-0000000000c2", file: "/tmp/sessions/parent/Tan-2.jsonl" };
const SECOND_CLONE_PROVIDER_SESSION_ID = `${PARENT.id}:tan:1002`;

function loopTurn(prompt: string): Context {
	return { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: prompt, timestamp: 1 }] };
}

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
	const binding = resolveCursorRequestBinding({ sessionId: session.id, providerSessionState }).binding!;
	const inSession = <T>(body: () => T): T => runInCursorSessionBinding(binding, body);
	return { pi, binding, providerSessionState, inSession };
}

/** A `/tan` clone's registration: the clone re-binds the prepared factory, never emits session_start. */
async function registerClone() {
	const pi = createExtensionPi([createTestToolInfo("custom_read")]);
	pi.getActiveTools.mockImplementation(() => ["custom_read"]);
	await cursorExtension(pi);
	return pi;
}

async function prompt(pi: Awaited<ReturnType<typeof registerClone>>, session: { id: string; file: string }, kind: "main" | "sub", text: string) {
	const ctx = createExtensionTestContext(sessionContext(session, kind));
	await pi.invokeEventWithContext(
		"before_agent_start",
		{ type: "before_agent_start", prompt: text, systemPrompt: [] },
		ctx,
	);
}

type ProviderRequest = Required<Pick<SimpleStreamOptions, "sessionId" | "providerSessionState">>;

function classifyIn(binding: CursorSessionBinding | undefined, context: Context, options: ProviderRequest) {
	const resolution = resolveCursorRequestBinding(options, context);
	const route = runInCursorSessionBinding(resolution.binding ?? binding!, () => classifyCursorRequestRoute(context, options, resolution));
	return { resolution, route };
}

function createAgentMock(agentId: string) {
	return { agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
}

function acquireFor(conversationId: string, agent: ReturnType<typeof createAgentMock>, mainConversation = true) {
	return acquireSessionCursorAgent({
		apiKey: "test-key",
		agentMode: "agent",
		cwd: "/tmp/project",
		modelSelection: { id: "composer-2.5" },
		conversationId,
		mainConversation,
		createAgent: vi.fn().mockResolvedValue(agent) as never,
	});
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
		expect(resolveCursorRequestBinding({ sessionId: PARENT.id, providerSessionState: parent.providerSessionState }).binding).toBe(parent.binding);
		expect(resolveCursorRequestBinding({ sessionId: PARENT.id, providerSessionState: new Map() }).binding).toBe(parent.binding);

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

describe("/tan clones (no session_start)", () => {
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

	it("pools a clone's turns on the clone's own binding, scope and bridge, and leaves the root alone", async () => {
		const root = await registerSession(PARENT, "main");
		// The root is prompted but its turn has not reached the provider yet: armed, unclaimed.
		await prompt(root.pi, PARENT, "main", "Refactor the parser");
		const rootBridge = root.inSession(() => getRegisteredCursorPiToolBridge()) as CursorPiToolBridgeRegistry;

		const clonePi = await registerClone();
		await prompt(clonePi, CLONE, "sub", "Write the tests");
		const cloneStore = new Map();
		const cloneRequest = { sessionId: CLONE_PROVIDER_SESSION_ID, providerSessionState: cloneStore };
		const first = classifyIn(undefined, loopTurn("Write the tests"), cloneRequest);
		expect(first.resolution.via).toBe("pending");
		const clone = first.resolution.binding!;
		expect(clone).not.toBe(root.binding);
		expect(first.route).toEqual({ oneShot: false, conversationId: CLONE_PROVIDER_SESSION_ID, mainConversation: true });
		const inClone = <T>(body: () => T): T => runInCursorSessionBinding(clone, body);
		// The clone's first prompt gave it its own scope.
		expect(inClone(() => getCursorSessionScopeKey())).toBe(CLONE.file);

		const cloneAgent = createAgentMock("agent-clone");
		const lease = await inClone(() =>
			acquireSessionCursorAgent({
				apiKey: "test-key",
				agentMode: "agent",
				cwd: "/tmp/project",
				modelSelection: { id: "composer-2.5" },
				conversationId: CLONE_PROVIDER_SESSION_ID,
				mainConversation: true,
				createAgent: vi.fn().mockResolvedValue(cloneAgent) as never,
			}),
		);
		expect(isOneShotCursorAgentLease(lease)).toBe(false);
		expect(lease.agent).toBe(cloneAgent);
		const cloneBridge = inClone(() => getRegisteredCursorPiToolBridge()) as CursorPiToolBridgeRegistry;
		expect(cloneBridge).not.toBe(rootBridge);
		expect(cloneBridge.getEndpointCount()).toBe(1);
		expect(rootBridge.getEndpointCount()).toBe(0);
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(CLONE.file, CLONE_PROVIDER_SESSION_ID))?.status).toBe("ready");
		// Its tool-result continuations resolve by the store its first turn taught.
		expect(resolveCursorRequestBinding(cloneRequest, loopTurn("Write the tests"))).toEqual({ via: "store", binding: clone });

		// The root's own turn still takes the root's main conversation.
		const rootTurn = classifyIn(undefined, loopTurn("Refactor the parser"), { sessionId: PARENT.id, providerSessionState: root.providerSessionState });
		expect(rootTurn.resolution).toEqual({ via: "store", binding: root.binding });
		expect(rootTurn.route.mainConversation).toBe(true);
		expect(root.inSession(() => getCursorSessionScopeKey())).toBe(PARENT.file);
	});

	it("tells clones prompted at the same time apart by their prompt, and runs an ambiguous request one-shot", async () => {
		await registerSession(PARENT, "main");
		const firstPi = await registerClone();
		const secondPi = await registerClone();
		await prompt(firstPi, CLONE, "sub", "Write the tests");
		await prompt(secondPi, SECOND_CLONE, "sub", "Update the docs");

		const second = classifyIn(undefined, loopTurn("Update the docs"), { sessionId: SECOND_CLONE_PROVIDER_SESSION_ID, providerSessionState: new Map() });
		expect(second.resolution.via).toBe("pending");
		expect(runInCursorSessionBinding(second.resolution.binding!, () => getCursorSessionScopeKey())).toBe(SECOND_CLONE.file);
		expect(second.route.mainConversation).toBe(true);

		const first = classifyIn(undefined, loopTurn("Write the tests"), { sessionId: CLONE_PROVIDER_SESSION_ID, providerSessionState: new Map() });
		expect(first.resolution.via).toBe("pending");
		expect(runInCursorSessionBinding(first.resolution.binding!, () => getCursorSessionScopeKey())).toBe(CLONE.file);

		const thirdPi = await registerClone();
		const fourthPi = await registerClone();
		await prompt(thirdPi, { id: "01a0e2f0-0000-7000-8000-0000000000c3", file: "/tmp/sessions/parent/Tan-3.jsonl" }, "sub", "Same work");
		await prompt(fourthPi, { id: "01a0e2f0-0000-7000-8000-0000000000c4", file: "/tmp/sessions/parent/Tan-4.jsonl" }, "sub", "Same work");
		const ambiguous = classifyIn(undefined, loopTurn("Same work"), { sessionId: `${PARENT.id}:tan:1003`, providerSessionState: new Map() });
		expect(ambiguous.resolution).toEqual({ via: "unknown" });
		expect(ambiguous.route.oneShot).toBe(true);
	});

	it("never lets a request that reached the root by falling back take its armed claim while a clone is pending", async () => {
		const root = await registerSession(PARENT, "main");
		await prompt(root.pi, PARENT, "main", "Refactor the parser");
		const clonePi = await registerClone();
		await prompt(clonePi, CLONE, "sub", "Write the tests");

		// Neither the store nor the id of any session (another in-process agent session).
		const stray = classifyIn(root.binding, loopTurn("Summarize the repo"), { sessionId: "01a0e2f0-0000-7000-8000-0000000000ee", providerSessionState: new Map() });
		expect(stray.resolution).toEqual({ via: "fallback", binding: root.binding, contested: true });
		expect(stray.route.oneShot).toBe(true);

		const rootTurn = classifyIn(undefined, loopTurn("Refactor the parser"), { sessionId: PARENT.id, providerSessionState: root.providerSessionState });
		expect(rootTurn.route.mainConversation).toBe(true);
	});
});

describe("session_switch (/new, /fork, /resume)", () => {
	const NEXT = { id: "01a0e2f0-0000-7000-8000-00000000e001", file: "/tmp/sessions/next.jsonl" };

	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingTestUtils.reset();
		await resetIndexExtensionTestState();
	});

	afterEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingTestUtils.reset();
	});

	/** agent-session.ts newSession / switchSession: emitted after the session manager switched. */
	async function switchSession(pi: Awaited<ReturnType<typeof registerClone>>, session: { id: string; file: string }, reason: "new" | "resume", previousSessionFile: string) {
		await pi.invokeEventWithContext(
			"session_switch",
			{ type: "session_switch", reason, previousSessionFile },
			createExtensionTestContext(sessionContext(session, "main")),
		);
	}

	it("moves scope, pool, resume state and the main conversation to the new session, and back on /resume", async () => {
		const root = await registerSession(PARENT, "main");
		expect(classifyIn(undefined, loopTurn("Refactor the parser"), { sessionId: PARENT.id, providerSessionState: root.providerSessionState }).route.mainConversation).toBe(true);
		const parentAgent = createAgentMock("agent-parent");
		await root.inSession(() => acquireFor(PARENT.id, parentAgent));
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(PARENT.file, PARENT.id))?.status).toBe("ready");

		await switchSession(root.pi, NEXT, "new", PARENT.file);
		expect(root.inSession(() => getCursorSessionScopeKey())).toBe(NEXT.file);
		expect(root.inSession(() => resumeTestUtils.state.sessionFile)).toBe(NEXT.file);
		expect(root.binding.sessionId).toBe(NEXT.id);
		// The previous session's pooled agent is torn down with its scope.
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(PARENT.file, PARENT.id))).toBeUndefined();
		expect(parentAgent[Symbol.asyncDispose]).toHaveBeenCalled();
		// The new session's turn (same AgentSession, same store) is the main conversation.
		const next = classifyIn(undefined, loopTurn("Write the tests"), { sessionId: NEXT.id, providerSessionState: root.providerSessionState });
		expect(next.resolution).toEqual({ via: "store", binding: root.binding });
		expect(next.route).toEqual({ oneShot: false, conversationId: NEXT.id, mainConversation: true });
		expect(resolveCursorRequestBinding({ sessionId: NEXT.id }).binding).toBe(root.binding);

		await switchSession(root.pi, PARENT, "resume", NEXT.file);
		expect(root.inSession(() => getCursorSessionScopeKey())).toBe(PARENT.file);
		expect(root.inSession(() => resumeTestUtils.state.sessionFile)).toBe(PARENT.file);
		expect(classifyIn(undefined, loopTurn("Refactor the parser"), { sessionId: PARENT.id, providerSessionState: root.providerSessionState }).route.mainConversation).toBe(true);
		const resumedAgent = createAgentMock("agent-resumed");
		const lease = await root.inSession(() => acquireFor(PARENT.id, resumedAgent));
		expect(isOneShotCursorAgentLease(lease)).toBe(false);
		expect(lease.agent).toBe(resumedAgent);
		expect(sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(PARENT.file, PARENT.id))?.status).toBe("ready");
	});

	it("keeps the Cursor skill activation tool active across the switch, so the next system prompt does not change", async () => {
		setActiveSkills([{ name: "demo", description: "Demo skill", filePath: "/tmp/skills/demo/SKILL.md", baseDir: "/tmp/skills/demo", source: "test" }]);
		try {
			const pi = createExtensionPi([createTestToolInfo("custom_read")]);
			await cursorExtension(pi);
			await pi.runSessionStart(sessionContext(PARENT, "main"));
			await prompt(pi, PARENT, "main", "Refactor the parser");
			expect(pi._activeToolNames()).toContain("cursor_activate_skill");
			pi.setActiveTools.mockClear();

			// omp builds the next prompt's system prompt from the active tools before that
			// prompt's before_agent_start runs.
			await switchSession(pi, NEXT, "new", PARENT.file);
			expect(pi._activeToolNames()).toContain("cursor_activate_skill");
			for (const [toolNames] of pi.setActiveTools.mock.calls) expect(toolNames).toContain("cursor_activate_skill");
		} finally {
			setActiveSkills([]);
		}
	});
});

describe("a new main conversation (/fresh)", () => {
	const FRESH_ID = "01a0e2f0-0000-7000-8000-00000000f001";
	const IDLE_ADVISOR_ID = "01a0e2f0-0000-7000-8000-00000000ad01";
	const BUSY_ADVISOR_ID = "01a0e2f0-0000-7000-8000-00000000ad02";
	const entry = (conversationId: string) => sessionAgentTestUtils.sessionAgentsByScope.get(sessionAgentEntryKey(PARENT.file, conversationId));

	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingTestUtils.reset();
		await resetIndexExtensionTestState();
	});

	afterEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingTestUtils.reset();
	});

	it("frees the previous main conversation's agent and idle advisor agents, and keeps a busy one", async () => {
		const root = await registerSession(PARENT, "main");
		await prompt(root.pi, PARENT, "main", "Refactor the parser");
		expect(classifyIn(undefined, loopTurn("Refactor the parser"), { sessionId: PARENT.id, providerSessionState: root.providerSessionState }).route.mainConversation).toBe(true);
		const mainAgent = createAgentMock("agent-main");
		const idleAdvisorAgent = createAgentMock("agent-advisor-idle");
		const busyAdvisorAgent = createAgentMock("agent-advisor-busy");
		await root.inSession(() => acquireFor(PARENT.id, mainAgent));
		await root.inSession(() => acquireFor(IDLE_ADVISOR_ID, idleAdvisorAgent, false));
		const busyAdvisor = await root.inSession(() => acquireFor(BUSY_ADVISOR_ID, busyAdvisorAgent, false));
		let finishAdvisorRun!: () => void;
		busyAdvisor.trackRunCompletion(new Promise<void>((resolve) => { finishAdvisorRun = resolve; }));

		// agent-session.ts freshSession: the next prompt's turn carries a new provider session
		// id and the same store. The request stops right after routing (aborted signal).
		await prompt(root.pi, PARENT, "main", "Start over");
		const controller = new AbortController();
		controller.abort();
		const stream = streamCursor(
			{ id: "composer-2.5", api: "cursor-sdk", provider: "cursor-sdk" } as never,
			loopTurn("Start over"),
			{ sessionId: FRESH_ID, providerSessionState: root.providerSessionState, signal: controller.signal },
		);
		for await (const _event of stream) {
			// drain
		}

		expect(entry(PARENT.id)).toBeUndefined();
		expect(entry(IDLE_ADVISOR_ID)).toBeUndefined();
		expect(entry(BUSY_ADVISOR_ID)?.status).toBe("busy");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mainAgent[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
		expect(idleAdvisorAgent[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
		expect(busyAdvisorAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
		finishAdvisorRun();
	});
});
