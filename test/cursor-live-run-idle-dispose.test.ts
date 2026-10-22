import type { SDKAgent } from "@cursor/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createCursorLiveRunCoordinator,
	type CursorLiveRun,
	type CursorLiveRunCreateParams,
} from "../src/cursor-live-run-coordinator.js";
import { __testUtils as bridgeTestUtils, registerCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";
import type { CursorPiBridgeToolRequest, CursorPiToolBridgeRun } from "../src/cursor-pi-tool-bridge-types.js";
import {
	CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV,
	cursorLiveRuns,
	DEFAULT_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS,
	resetCursorLiveRunIdleDisposeMs,
	resolveCursorLiveRunIdleDisposeMs,
	setCursorLiveRunIdleDisposeMs,
} from "../src/cursor-provider-live-run-drain.js";
import { createBridgePiHarness, createTestToolInfo, getCursorPiBridgeMcpUrl } from "./helpers/pi-harness.js";
import type { BridgePiHarness } from "./helpers/pi-harness-types.js";

// Real short timers on purpose: vitest fake timers are not reliable under bun in this repo (the legacy
// coordinator suite fails on them), and the behavior under test is the coordinator's own setTimeout
// scheduling. Assertions that something has NOT happened yet leave a wide margin below the window;
// assertions that something happened wait with a generous deadline, so a slow machine can only make a
// test slower, never flaky.

/** Timer granularity slack for "no earlier than the window" checks. */
const TIMER_EARLY_TOLERANCE_MS = 10;

function sleep(ms: number): Promise<void> {
	// Promise.withResolvers is outside this repo's test tsconfig lib.
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("Timed out waiting for condition");
		await sleep(5);
	}
}

function makeAgent(): SDKAgent {
	return { agentId: "agent-1" } as SDKAgent;
}

type OwnedBridgeSlot = "bridgeRun" | "sessionBridgeRun";

function ownedBy(slot: OwnedBridgeSlot, bridge: CursorPiToolBridgeRun): Pick<CursorLiveRunCreateParams, OwnedBridgeSlot> {
	return slot === "bridgeRun" ? { bridgeRun: bridge } : { sessionBridgeRun: bridge };
}

/**
 * A bridge whose calls the test drives. It follows the real contract: a call is pending from `addCall`
 * until `settleCall`, it stops being "executing" at `markResultReady` (omp produced its tool result) or
 * when it settles, and observers run synchronously after the state changed.
 */
function makeFakeBridge(id: string) {
	/** pending piToolCallId -> omp already produced its result */
	const calls = new Map<string, boolean>();
	const listeners = new Set<() => void>();
	const onExecutingToolCallsChanged = vi.fn((listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	});
	const notify = (): void => {
		for (const listener of [...listeners]) listener();
	};
	const bridge: CursorPiToolBridgeRun = {
		id,
		enabled: true,
		snapshot: { tools: [], mcpToolNameToPiToolName: new Map(), piToolNameToMcpToolName: new Map() },
		takeQueuedToolRequests: () => [],
		resolveToolResults: async () => {},
		resolveToolResultsFromContext: async () => {},
		hasPendingPiToolCallId: (piToolCallId) => calls.has(piToolCallId),
		hasExecutingToolCalls: () => [...calls.values()].some((resultReady) => !resultReady),
		onExecutingToolCallsChanged,
		isBridgeMcpToolCall: () => false,
		setOnToolRequest: vi.fn(),
		setDebugRecorder: vi.fn(),
		cancel: vi.fn(),
		dispose: vi.fn(async () => {}),
	};
	return {
		bridge,
		listeners,
		onExecutingToolCallsChanged,
		addCall(callId: string): void {
			calls.set(callId, false);
			notify();
		},
		markResultReady(callId: string): void {
			calls.set(callId, true);
			notify();
		},
		settleCall(callId: string): void {
			const wasExecuting = calls.get(callId) === false;
			calls.delete(callId);
			if (wasExecuting) notify();
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function makeHarness(idleDisposeMs: number) {
	const coordinator = createCursorLiveRunCoordinator({
		getScopeKey: () => "default-scope",
		getIdleDisposeMs: () => idleDisposeMs,
		deleteNativeToolDisplay: vi.fn(),
		abandonSessionAgent: vi.fn(async () => {}),
	});
	const runs: CursorLiveRun[] = [];
	cleanups.push(async () => {
		for (const run of runs) await coordinator.release(run);
	});
	let counter = 0;
	function start(options: Partial<Pick<CursorLiveRunCreateParams, OwnedBridgeSlot>> & { scopeKey?: string } = {}): CursorLiveRun {
		counter += 1;
		const run = coordinator.start({
			id: `idle-run-${counter}`,
			agent: makeAgent(),
			bridgeRun: options.bridgeRun,
			sessionBridgeRun: options.sessionBridgeRun,
			sessionAgentScopeKey: options.scopeKey ?? `idle-scope-${counter}`,
			promptInputTokens: 0,
		});
		runs.push(run);
		return run;
	}
	return { coordinator, start };
}

describe("live-run idle disposal while omp executes owned bridge calls", () => {
	it.each(["bridgeRun", "sessionBridgeRun"] as const)(
		"does not release a run whose %s has an executing call when the idle window passes",
		async (slot) => {
			const { coordinator, start } = makeHarness(30);
			const owned = makeFakeBridge("owned");
			owned.addCall("call-1");
			const run = start(ownedBy(slot, owned.bridge));

			coordinator.requestIdleDispose(run);
			await sleep(30 * 6);

			expect(run.disposed).toBe(false);
			expect(coordinator.count()).toBe(1);
			expect(owned.bridge.cancel).not.toHaveBeenCalled();
		},
	);

	it("restarts the full window only after the last executing call on every owned bridge finishes", async () => {
		const windowMs = 250;
		const { coordinator, start } = makeHarness(windowMs);
		const runBridge = makeFakeBridge("run-bridge");
		const sessionBridge = makeFakeBridge("session-bridge");
		runBridge.addCall("run-call");
		sessionBridge.addCall("session-call");
		const run = start({ bridgeRun: runBridge.bridge, sessionBridgeRun: sessionBridge.bridge });

		coordinator.requestIdleDispose(run);
		await sleep(windowMs * 1.5);
		expect(run.disposed).toBe(false);

		runBridge.settleCall("run-call");
		await sleep(windowMs * 1.5);
		expect(run.disposed).toBe(false);

		sessionBridge.markResultReady("session-call");
		const finishedAt = performance.now();
		expect(run.disposed).toBe(false);
		await sleep(windowMs / 5);
		expect(run.disposed).toBe(false);

		await waitUntil(() => run.disposed);
		expect(performance.now() - finishedAt).toBeGreaterThanOrEqual(windowMs - TIMER_EARLY_TOLERANCE_MS);
		expect(runBridge.bridge.cancel).toHaveBeenCalledTimes(1);
		expect(coordinator.count()).toBe(0);
	});

	it("does not hold a run for a call whose result omp already produced", async () => {
		const { coordinator, start } = makeHarness(30);
		const owned = makeFakeBridge("owned");
		owned.addCall("abandoned-call");
		owned.markResultReady("abandoned-call");
		const run = start({ bridgeRun: owned.bridge });
		// The call is still pending for resolution by the next provider request.
		expect(owned.bridge.hasPendingPiToolCallId("abandoned-call")).toBe(true);

		coordinator.requestIdleDispose(run);
		await waitUntil(() => run.disposed);

		expect(owned.bridge.cancel).toHaveBeenCalledTimes(1);
	});

	it("does not let a sibling run's executing call delay this run", async () => {
		const { coordinator, start } = makeHarness(30);
		const siblingBridge = makeFakeBridge("sibling-bridge");
		siblingBridge.addCall("sibling-call");
		const ownBridge = makeFakeBridge("own-bridge");
		const sibling = start({ bridgeRun: siblingBridge.bridge, scopeKey: "sibling-scope" });
		const run = start({ bridgeRun: ownBridge.bridge, scopeKey: "own-scope" });

		coordinator.requestIdleDispose(sibling);
		coordinator.requestIdleDispose(run);
		await waitUntil(() => run.disposed);

		expect(sibling.disposed).toBe(false);
		expect(coordinator.count()).toBe(1);
		expect(siblingBridge.bridge.cancel).not.toHaveBeenCalled();
		expect(ownBridge.bridge.cancel).toHaveBeenCalledTimes(1);
	});

	it("still cancels an executing call immediately on explicit release", async () => {
		const { coordinator, start } = makeHarness(30);
		const owned = makeFakeBridge("owned");
		owned.addCall("call-1");
		const run = start({ bridgeRun: owned.bridge });
		coordinator.requestIdleDispose(run);

		await coordinator.release(run);

		expect(run.disposed).toBe(true);
		expect(coordinator.count()).toBe(0);
		expect(owned.bridge.cancel).toHaveBeenCalledTimes(1);
		expect(owned.bridge.cancel).toHaveBeenCalledWith("Cursor live run released");
	});

	it("cancels an armed window when a call starts executing, then restarts it when the call finishes", async () => {
		const { coordinator, start } = makeHarness(30);
		const owned = makeFakeBridge("owned");
		const run = start({ bridgeRun: owned.bridge });

		coordinator.requestIdleDispose(run);
		// The timer is armed but no macrotask has run, so it cannot have fired yet.
		owned.addCall("late-call");
		await sleep(30 * 6);
		expect(run.disposed).toBe(false);
		expect(owned.bridge.cancel).not.toHaveBeenCalled();

		owned.markResultReady("late-call");
		await waitUntil(() => run.disposed);
		expect(owned.bridge.cancel).toHaveBeenCalledTimes(1);
	});

	it("subscribes once per distinct owned bridge and detaches every observer on release", async () => {
		const { coordinator, start } = makeHarness(30);
		const shared = makeFakeBridge("shared");
		const sharedRun = start({ bridgeRun: shared.bridge, sessionBridgeRun: shared.bridge });
		const runBridge = makeFakeBridge("run-bridge");
		const sessionBridge = makeFakeBridge("session-bridge");
		const splitRun = start({ bridgeRun: runBridge.bridge, sessionBridgeRun: sessionBridge.bridge });

		expect(shared.onExecutingToolCallsChanged).toHaveBeenCalledTimes(1);
		expect(runBridge.onExecutingToolCallsChanged).toHaveBeenCalledTimes(1);
		expect(sessionBridge.onExecutingToolCallsChanged).toHaveBeenCalledTimes(1);

		await coordinator.release(sharedRun);
		await coordinator.release(splitRun);

		expect(shared.listeners.size).toBe(0);
		expect(runBridge.listeners.size).toBe(0);
		expect(sessionBridge.listeners.size).toBe(0);
	});

	it("holds disposal while a lease is open and restarts the full window when it ends", async () => {
		const windowMs = 80;
		const { coordinator, start } = makeHarness(windowMs);
		const run = start();

		await coordinator.withRunLease(run, undefined, async () => {
			coordinator.requestIdleDispose(run);
			await sleep(windowMs * 3);
			expect(run.disposed).toBe(false);
		});
		const leaseEndedAt = performance.now();
		expect(run.disposed).toBe(false);

		await waitUntil(() => run.disposed);
		expect(performance.now() - leaseEndedAt).toBeGreaterThanOrEqual(windowMs - TIMER_EARLY_TOLERANCE_MS);
	});

	it("defers the last call's window to the end of a lease it finished in", async () => {
		const windowMs = 80;
		const { coordinator, start } = makeHarness(windowMs);
		const owned = makeFakeBridge("owned");
		owned.addCall("call-1");
		const run = start({ bridgeRun: owned.bridge });
		coordinator.requestIdleDispose(run);

		await coordinator.withRunLease(run, undefined, async () => {
			owned.settleCall("call-1");
			await sleep(windowMs * 3);
			expect(run.disposed).toBe(false);
		});
		const leaseEndedAt = performance.now();
		expect(run.disposed).toBe(false);

		await waitUntil(() => run.disposed);
		expect(performance.now() - leaseEndedAt).toBeGreaterThanOrEqual(windowMs - TIMER_EARLY_TOLERANCE_MS);
	});

	it("collects a queued bridge tool request that is pending on the session bridge, not only on bridgeRun", () => {
		const { coordinator, start } = makeHarness(30);
		const runBridge = makeFakeBridge("run-bridge");
		const sessionBridge = makeFakeBridge("session-bridge");
		sessionBridge.addCall("session-pi-call");
		const run = start({ bridgeRun: runBridge.bridge, sessionBridgeRun: sessionBridge.bridge });
		const request = (runId: string, piToolCallId: string): CursorPiBridgeToolRequest => ({
			runId,
			bridgeCallId: `${runId}-bridge-call`,
			piToolCallId,
			piToolName: "custom_read",
			mcpToolName: "pi__custom_read",
			args: {},
		});
		coordinator.queueEvent(run, { type: "bridge-tool", request: request("session-bridge", "session-pi-call") });
		coordinator.queueEvent(run, { type: "bridge-tool", request: request("run-bridge", "not-pending-call") });
		coordinator.queueEvent(run, { type: "bridge-tool", request: request("foreign-bridge", "session-pi-call") });

		expect(coordinator.collectBridgeToolBatch(run).map((entry) => entry.piToolCallId)).toEqual(["session-pi-call"]);
		expect(coordinator.peekEvent(run)).toBeUndefined();
	});
});

describe("bridge run executing-call tracking (real bridge run and omp hooks)", () => {
	afterEach(() => {
		delete process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS;
	});

	async function createRealBridge() {
		const pi = createBridgePiHarness({
			active: ["custom_read"],
			tools: [createTestToolInfo("custom_read")],
		});
		const bridge = registerCursorPiToolBridge(pi);
		const run = await bridge.createRun();
		const client = new Client({ name: "idle-dispose-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(getCursorPiBridgeMcpUrl(run)));
		await client.connect(transport);
		cleanups.push(async () => {
			await client.close().catch(() => undefined);
			await transport.close().catch(() => undefined);
			await run.dispose();
			await bridge.disposeAll();
			await bridgeTestUtils.resetRegisteredBridgeForTests();
		});
		const mcpToolName = run.snapshot.tools[0]?.mcpToolName;
		if (!mcpToolName) throw new Error("Test bridge exposed no tool");
		return {
			pi,
			run,
			/** Starts an MCP call; the promise resolves to the result or to the error the client saw. */
			callTool: (): Promise<unknown> => client.callTool({ name: mcpToolName, arguments: {} }).catch((error: unknown) => error),
		};
	}

	async function waitForQueuedRequests(run: CursorPiToolBridgeRun, count = 1): Promise<CursorPiBridgeToolRequest[]> {
		const requests: CursorPiBridgeToolRequest[] = [];
		await waitUntil(() => {
			requests.push(...run.takeQueuedToolRequests());
			return requests.length >= count;
		});
		return requests;
	}

	/** omp starts executing the bridged tool: its tool_call hook runs. */
	async function ompStartsTool(pi: BridgePiHarness, request: CursorPiBridgeToolRequest): Promise<void> {
		const hookResult = await pi.runToolCall(
			{ type: "tool_call", toolCallId: request.piToolCallId, toolName: request.piToolName, input: request.args },
			{ abort: vi.fn() },
		);
		expect(hookResult).toBeUndefined();
	}

	/** omp is done with the tool (completed, failed or aborted): its tool_result hook runs. */
	async function ompProducesToolResult(
		pi: BridgePiHarness,
		request: CursorPiBridgeToolRequest,
		options: { isError: boolean; text: string },
	): Promise<void> {
		await pi.runToolResult({
			type: "tool_result",
			toolCallId: request.piToolCallId,
			toolName: request.piToolName,
			input: request.args,
			content: [{ type: "text", text: options.text }],
			isError: options.isError,
			details: undefined,
		});
	}

	function makeToolResult(request: CursorPiBridgeToolRequest): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId: request.piToolCallId,
			toolName: request.piToolName,
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
		};
	}

	it("notifies synchronously when a call starts, finishes executing, is cancelled, or the run is disposed", async () => {
		const { run, callTool } = await createRealBridge();
		const seen: boolean[] = [];
		run.onExecutingToolCallsChanged(() => seen.push(run.hasExecutingToolCalls()));
		expect(run.hasExecutingToolCalls()).toBe(false);

		const settledCall = callTool();
		const [settledRequest] = await waitForQueuedRequests(run);
		expect(run.hasExecutingToolCalls()).toBe(true);
		expect(seen).toEqual([true]);

		const settling = run.resolveToolResults([makeToolResult(settledRequest!)]);
		expect(seen).toEqual([true, false]);
		await settling;
		expect(await settledCall).not.toBeInstanceOf(Error);

		const cancelledCall = callTool();
		await waitForQueuedRequests(run);
		expect(seen).toEqual([true, false, true]);
		run.cancel("cancelled by test");
		expect(seen).toEqual([true, false, true, false]);
		expect(run.hasExecutingToolCalls()).toBe(false);
		expect(await cancelledCall).toBeInstanceOf(Error);

		void callTool();
		await waitForQueuedRequests(run);
		expect(seen.slice(4)).toEqual([true]);
		const disposal = run.dispose();
		expect(seen.slice(4)).toEqual([true, false]);
		expect(run.hasExecutingToolCalls()).toBe(false);
		await disposal;
	});

	it("notifies when a call times out, so a stranded call cannot hold a run forever", async () => {
		process.env.PI_CURSOR_PI_BRIDGE_CALL_TIMEOUT_MS = "200";
		const { run, callTool } = await createRealBridge();
		const seen: boolean[] = [];
		run.onExecutingToolCallsChanged(() => seen.push(run.hasExecutingToolCalls()));

		const call = callTool();
		await waitForQueuedRequests(run);
		expect(run.hasExecutingToolCalls()).toBe(true);

		await waitUntil(() => !run.hasExecutingToolCalls());
		expect(seen).toEqual([true, false]);
		expect(await call).toBeInstanceOf(Error);
	});

	it("keeps settling the call and notifying later observers when an observer throws", async () => {
		const { run, callTool } = await createRealBridge();
		const seen: boolean[] = [];
		run.onExecutingToolCallsChanged(() => {
			throw new Error("observer failure");
		});
		run.onExecutingToolCallsChanged(() => seen.push(run.hasExecutingToolCalls()));

		const call = callTool();
		const [request] = await waitForQueuedRequests(run);
		expect(run.hasPendingPiToolCallId(request!.piToolCallId)).toBe(true);

		await expect(run.resolveToolResults([makeToolResult(request!)])).resolves.toBeUndefined();

		expect(await call).toMatchObject({ content: [{ type: "text", text: "done" }] });
		expect(seen).toEqual([true, false]);
	});

	it("unsubscribes idempotently without dropping another subscription of the same listener", async () => {
		const { run, callTool } = await createRealBridge();
		let sameListenerCalls = 0;
		const sameListener = (): void => {
			sameListenerCalls += 1;
		};
		let otherCalls = 0;
		const unsubscribeFirst = run.onExecutingToolCallsChanged(sameListener);
		const unsubscribeSecond = run.onExecutingToolCallsChanged(sameListener);
		run.onExecutingToolCallsChanged(() => {
			otherCalls += 1;
		});

		unsubscribeFirst();
		unsubscribeFirst();
		const call = callTool();
		const [request] = await waitForQueuedRequests(run);
		expect([sameListenerCalls, otherCalls]).toEqual([1, 1]);

		unsubscribeSecond();
		await run.resolveToolResults([makeToolResult(request!)]);
		await call;
		expect([sameListenerCalls, otherCalls]).toEqual([1, 2]);
	});

	it("stops counting a call once omp produced its tool result, but keeps it resolvable by the next provider request", async () => {
		const { pi, run, callTool } = await createRealBridge();
		const seen: boolean[] = [];
		run.onExecutingToolCallsChanged(() => seen.push(run.hasExecutingToolCalls()));
		const call = callTool();
		const [request] = await waitForQueuedRequests(run);
		await ompStartsTool(pi, request!);
		expect(bridgeTestUtils.getActiveBridgeToolExecutionAbortCount()).toBe(1);
		expect(seen).toEqual([true]);

		await ompProducesToolResult(pi, request!, { isError: false, text: "done" });

		expect(run.hasExecutingToolCalls()).toBe(false);
		expect(seen).toEqual([true, false]);
		// omp no longer tracks the execution, so a later turn_end or abort has nothing left to cancel.
		expect(bridgeTestUtils.getActiveBridgeToolExecutionAbortCount()).toBe(0);
		expect(run.hasPendingPiToolCallId(request!.piToolCallId)).toBe(true);

		await run.resolveToolResults([makeToolResult(request!)]);

		expect(await call).toMatchObject({ content: [{ type: "text", text: "done" }] });
		expect(run.hasPendingPiToolCallId(request!.piToolCallId)).toBe(false);
		// Settling a call that was already not executing changes nothing for observers.
		expect(seen).toEqual([true, false]);
	});

	it("ignores a tool_result for a call the bridge does not own", async () => {
		const { pi, run, callTool } = await createRealBridge();
		const seen: boolean[] = [];
		run.onExecutingToolCallsChanged(() => seen.push(run.hasExecutingToolCalls()));
		void callTool();
		const [request] = await waitForQueuedRequests(run);
		expect(seen).toEqual([true]);

		await ompProducesToolResult(pi, { ...request!, piToolCallId: "unrelated-tool-call" }, { isError: false, text: "other" });

		expect(run.hasExecutingToolCalls()).toBe(true);
		expect(seen).toEqual([true]);
	});

	it.each<[string, boolean, string]>([
		["completes", false, "tool output"],
		["is aborted by the user", true, "Tool execution was aborted"],
	])(
		"a live run stops being held once omp produced the tool result (the tool %s) and is released one full window later",
		async (_label, isError, text) => {
			const windowMs = 250;
			const { coordinator, start } = makeHarness(windowMs);
			const { pi, run: bridge, callTool } = await createRealBridge();
			const liveRun = start({ bridgeRun: bridge, sessionBridgeRun: bridge });
			const call = callTool();
			const [request] = await waitForQueuedRequests(bridge);
			await ompStartsTool(pi, request!);
			coordinator.requestIdleDispose(liveRun);

			await sleep(windowMs * 1.5);
			expect(liveRun.disposed).toBe(false);
			expect(bridge.hasExecutingToolCalls()).toBe(true);

			await ompProducesToolResult(pi, request!, { isError, text });
			const producedAt = performance.now();
			expect(bridge.hasExecutingToolCalls()).toBe(false);
			expect(bridge.hasPendingPiToolCallId(request!.piToolCallId)).toBe(true);
			expect(liveRun.disposed).toBe(false);
			await sleep(windowMs / 5);
			expect(liveRun.disposed).toBe(false);

			await waitUntil(() => liveRun.disposed);
			expect(performance.now() - producedAt).toBeGreaterThanOrEqual(windowMs - TIMER_EARLY_TOLERANCE_MS);
			// Releasing the run cancelled the call nobody resolved.
			expect(await call).toBeInstanceOf(Error);
			expect(bridge.hasPendingPiToolCallId(request!.piToolCallId)).toBe(false);
		},
	);

	it("keeps holding a live run while any other call is still executing", async () => {
		const windowMs = 250;
		const { coordinator, start } = makeHarness(windowMs);
		const { pi, run: bridge, callTool } = await createRealBridge();
		const liveRun = start({ bridgeRun: bridge, sessionBridgeRun: bridge });
		const firstCall = callTool();
		const secondCall = callTool();
		const [first, second] = await waitForQueuedRequests(bridge, 2);
		await ompStartsTool(pi, first!);
		await ompStartsTool(pi, second!);
		coordinator.requestIdleDispose(liveRun);

		await ompProducesToolResult(pi, first!, { isError: false, text: "first done" });
		expect(bridge.hasExecutingToolCalls()).toBe(true);
		await sleep(windowMs * 1.5);
		expect(liveRun.disposed).toBe(false);

		await ompProducesToolResult(pi, second!, { isError: false, text: "second done" });
		const producedAt = performance.now();
		expect(bridge.hasExecutingToolCalls()).toBe(false);
		await sleep(windowMs / 5);
		expect(liveRun.disposed).toBe(false);

		await waitUntil(() => liveRun.disposed);
		expect(performance.now() - producedAt).toBeGreaterThanOrEqual(windowMs - TIMER_EARLY_TOLERANCE_MS);
		expect(await firstCall).toBeInstanceOf(Error);
		expect(await secondCall).toBeInstanceOf(Error);
	});

	it("cancels a real executing call when the live run is released explicitly", async () => {
		const { coordinator, start } = makeHarness(30);
		const { pi, run: bridge, callTool } = await createRealBridge();
		const liveRun = start({ bridgeRun: bridge, sessionBridgeRun: bridge });
		const call = callTool();
		const [request] = await waitForQueuedRequests(bridge);
		await ompStartsTool(pi, request!);
		coordinator.requestIdleDispose(liveRun);
		await sleep(30 * 4);
		expect(bridge.hasExecutingToolCalls()).toBe(true);

		await coordinator.release(liveRun);

		expect(liveRun.disposed).toBe(true);
		expect(bridge.hasExecutingToolCalls()).toBe(false);
		expect(await call).toBeInstanceOf(Error);
	});
});

describe("PI_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS", () => {
	let originalEnv: string | undefined;
	let counter = 0;

	beforeEach(() => {
		originalEnv = process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV];
		delete process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV];
		resetCursorLiveRunIdleDisposeMs();
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV];
		else process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = originalEnv;
		resetCursorLiveRunIdleDisposeMs();
	});

	function startRun(bridgeRun?: CursorPiToolBridgeRun): CursorLiveRun {
		counter += 1;
		const run = cursorLiveRuns.start({
			id: `idle-env-run-${counter}`,
			agent: makeAgent(),
			bridgeRun,
			sessionAgentScopeKey: `idle-env-scope-${counter}`,
			promptInputTokens: 0,
		});
		cleanups.push(() => cursorLiveRuns.release(run));
		return run;
	}

	it("defaults to five minutes", () => {
		expect(DEFAULT_CURSOR_LIVE_RUN_IDLE_DISPOSE_MS).toBe(300_000);
	});

	it.each<[string | undefined, number]>([
		[undefined, 300_000],
		["", 300_000],
		["abc", 300_000],
		["0", 300_000],
		["1", 1],
		["900000", 900_000],
		["0900", 900],
		["2147483647", 2_147_483_647],
		["2147483648", 300_000],
		["999999999999999999999", 300_000],
		[" 5", 300_000],
		["5 ", 300_000],
		["5\n", 300_000],
		["\n5", 300_000],
		["-5", 300_000],
		["+5", 300_000],
		["1.5", 300_000],
		["1e3", 300_000],
		["0x10", 300_000],
		["５", 300_000],
	])("resolves %j to %i ms", (raw, expected) => {
		const env = raw === undefined ? {} : { [CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV]: raw };

		expect(resolveCursorLiveRunIdleDisposeMs(env)).toBe(expected);
	});

	it("reads the process environment when no environment is passed", () => {
		process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = "123";

		expect(resolveCursorLiveRunIdleDisposeMs()).toBe(123);
	});

	it("arms the idle timer with the configured window, not the five-minute default", async () => {
		process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = "150";
		const run = startRun();

		cursorLiveRuns.markFinished(run, "done");
		const armedAt = performance.now();
		await sleep(40);
		expect(run.disposed).toBe(false);

		await waitUntil(() => run.disposed);
		expect(performance.now() - armedAt).toBeGreaterThanOrEqual(150 - TIMER_EARLY_TOLERANCE_MS);
		expect(cursorLiveRuns.getActiveForScope(run.sessionAgentScopeKey)).toBeUndefined();
	});

	it("reads the variable again every time the timer is armed", async () => {
		process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = "60";
		const first = startRun();
		cursorLiveRuns.markFinished(first, "done");
		await waitUntil(() => first.disposed);

		process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = "60000";
		const second = startRun();
		cursorLiveRuns.markFinished(second, "done");
		await sleep(250);

		expect(second.disposed).toBe(false);
	});

	it("lets an explicit override outrank the variable until it is reset", async () => {
		process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = "60000";
		setCursorLiveRunIdleDisposeMs(20);
		const overridden = startRun();

		cursorLiveRuns.markFinished(overridden, "done");
		await waitUntil(() => overridden.disposed);

		resetCursorLiveRunIdleDisposeMs();
		const afterReset = startRun();
		cursorLiveRuns.markFinished(afterReset, "done");
		await sleep(250);

		expect(afterReset.disposed).toBe(false);
	});

	it("keeps a run with an executing call past the configured window and releases it one window after the call finishes", async () => {
		process.env[CURSOR_LIVE_RUN_IDLE_DISPOSE_MS_ENV] = "250";
		const owned = makeFakeBridge("owned");
		owned.addCall("call-1");
		const run = startRun(owned.bridge);

		cursorLiveRuns.markFinished(run, "done");
		await sleep(250 * 1.5);
		expect(run.disposed).toBe(false);
		expect(owned.bridge.cancel).not.toHaveBeenCalled();

		owned.markResultReady("call-1");
		const finishedAt = performance.now();
		expect(run.disposed).toBe(false);
		await sleep(250 / 5);
		expect(run.disposed).toBe(false);

		await waitUntil(() => run.disposed);
		expect(performance.now() - finishedAt).toBeGreaterThanOrEqual(250 - TIMER_EARLY_TOLERANCE_MS);
		expect(owned.bridge.cancel).toHaveBeenCalledTimes(1);
	});
});
