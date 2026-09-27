import { describe, expect, it } from "vitest";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import {
	cursorLiveRuns,
	flushPendingCursorLiveRunTraceEventsToStream,
} from "../src/cursor-provider-live-run-drain.js";

function createPartial() {
	return {
		role: "assistant",
		content: [],
		api: "cursor-sdk",
		provider: "cursor-sdk",
		model: "test",
	} as any;
}

function createStream() {
	return { push() {} } as any;
}

function createCoordinator(partial: any, liveRun?: any) {
	return new CursorSdkTurnCoordinator({
		stream: createStream(),
		partial,
		cwd: "/tmp",
		useNativeToolReplay: false,
		nativeReplayId: "test",
		textDeltas: [],
		liveRun,
	});
}

describe("Cursor assistant text boundaries", () => {
	it("separates consecutive direct assistant messages", () => {
		const partial = createPartial();
		const coordinator = createCoordinator(partial);

		coordinator.handleDelta({ type: "text-delta", text: "A" } as any);
		coordinator.handleStep({ type: "assistantMessage" });
		coordinator.handleDelta({ type: "text-delta", text: "B" } as any);
		coordinator.flushText([]);

		expect(partial.content.map((block: any) => block.text).join("")).toBe("A\n\nB");
	});

	it("separates consecutive messages in the live-run drain", async () => {
		const partial = createPartial();
		const run = cursorLiveRuns.start({
			id: "text-boundary-test",
			agent: {} as any,
			promptInputTokens: 0,
		});
		const coordinator = createCoordinator(partial, run);

		coordinator.handleDelta({ type: "text-delta", text: "A" } as any);
		coordinator.handleStep({ type: "assistantMessage" });
		coordinator.handleDelta({ type: "text-delta", text: "B" } as any);
		flushPendingCursorLiveRunTraceEventsToStream(createStream(), partial, run);

		expect(partial.content.map((block: any) => block.text).join("")).toBe("A\n\nB");
		await cursorLiveRuns.release(run);
	});
});
