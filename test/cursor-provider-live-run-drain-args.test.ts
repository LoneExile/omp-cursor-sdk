import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { CursorPiToolBridgeRun } from "../src/cursor-pi-tool-bridge.js";
import { cursorLiveRuns, drainCursorLiveRunTurn } from "../src/cursor-provider-live-run-drain.js";
import { makeAssistantMessage, makeContext, makeModel } from "./helpers/pi-harness.js";

function makeBridgeRun(id: string, pendingPiToolCallIds: string[]): CursorPiToolBridgeRun {
	const pending = new Set(pendingPiToolCallIds);
	return {
		id,
		enabled: true,
		snapshot: { tools: [], mcpToolNameToPiToolName: new Map(), piToolNameToMcpToolName: new Map() },
		takeQueuedToolRequests: vi.fn(() => []),
		resolveToolResults: vi.fn().mockResolvedValue(undefined),
		resolveToolResultsFromContext: vi.fn().mockResolvedValue(undefined),
		hasPendingPiToolCallId: vi.fn((piToolCallId: string) => pending.has(piToolCallId)),
		isBridgeMcpToolCall: vi.fn(() => false),
		setOnToolRequest: vi.fn(),
		setDebugRecorder: vi.fn(),
		cancel: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

describe("cursor live-run drain tool arguments", () => {
	it("emits JSON object bridge arguments on the host transcript unchanged", async () => {
		const args = { path: "README.md" };
		const bridgeRun = makeBridgeRun("bridge-object-args", ["pi-call-object"]);
		const run = cursorLiveRuns.start({
			id: "bridge-object-args-run",
			agent: { agentId: "agent-1" } as never,
			bridgeRun,
			sessionAgentScopeKey: "bridge-object-args-scope",
			promptInputTokens: 1,
		});
		cursorLiveRuns.queueEvent(run, {
			type: "bridge-tool",
			request: {
				runId: bridgeRun.id,
				bridgeCallId: "bridge-call-object",
				piToolCallId: "pi-call-object",
				piToolName: "read",
				mcpToolName: "pi__read",
				args,
			},
		});
		cursorLiveRuns.markFinished(run, "done");
		const stream = createAssistantMessageEventStream();
		const push = vi.spyOn(stream, "push");
		const partial = makeAssistantMessage("");

		await drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, { mode: "emit" });

		const toolCall = partial.content.find((block) => block.type === "toolCall");
		expect(toolCall?.arguments).toBe(args);
		expect(push.mock.calls.some(([event]) => event.type === "toolcall_delta" && event.delta === JSON.stringify(args))).toBe(
			true,
		);
	});

	it("does not JSON.stringify non-object bridge arguments onto the host transcript", async () => {
		const bridgeRun = makeBridgeRun("bridge-array-args", ["pi-call-array"]);
		const run = cursorLiveRuns.start({
			id: "bridge-array-args-run",
			agent: { agentId: "agent-1" } as never,
			bridgeRun,
			sessionAgentScopeKey: "bridge-array-args-scope",
			promptInputTokens: 1,
		});
		cursorLiveRuns.queueEvent(run, {
			type: "bridge-tool",
			request: {
				runId: bridgeRun.id,
				bridgeCallId: "bridge-call-array",
				piToolCallId: "pi-call-array",
				piToolName: "read",
				mcpToolName: "pi__read",
				args: ["not", "an", "object"] as unknown as Record<string, unknown>,
			},
		});
		cursorLiveRuns.markFinished(run, "done");
		const stream = createAssistantMessageEventStream();
		const push = vi.spyOn(stream, "push");
		const partial = makeAssistantMessage("");

		await expect(
			drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, { mode: "emit" }),
		).rejects.toThrow("Cursor bridge tool arguments must be a JSON object");
		expect(push.mock.calls.map(([event]) => event.type)).not.toContain("toolcall_start");
	});
});
