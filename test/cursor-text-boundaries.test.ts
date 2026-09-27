import { describe, expect, it } from "vitest";
import { CursorPartialContentEmitter } from "../src/cursor-partial-content-emitter.js";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import {
	cursorLiveRuns,
	flushPendingCursorLiveRunTraceEventsToStream,
} from "../src/cursor-provider-live-run-drain.js";

// omp print mode writes every text block followed by "\n" (pi-coding-agent
// modes/print-mode.ts:322-324); the TUI renders each text block trimmed, with no
// spacing between adjacent text blocks and whitespace-only blocks skipped
// (pi-tui chat/assistant-message.ts:1107-1117).
function printModeStdout(partial: any): string {
	return partial.content
		.filter((block: any) => block.type === "text")
		.map((block: any) => `${block.text}\n`)
		.join("");
}

function contentShape(partial: any): Array<[string, string?]> {
	return partial.content.map((block: any) => (block.type === "text" ? ["text", block.text] : [block.type]));
}

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

function createCoordinator(partial: any, liveRun?: any, textDeltas: string[] = []) {
	return new CursorSdkTurnCoordinator({
		stream: createStream(),
		partial,
		cwd: "/tmp",
		useNativeToolReplay: false,
		nativeReplayId: "test",
		textDeltas,
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

		expect(contentShape(partial)).toEqual([["text", "A\n\nB"]]);
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

		expect(contentShape(partial)).toEqual([["text", "A\n\nB"]]);
		expect(run.emittedText).toBe("A\n\nB");
		await cursorLiveRuns.release(run);
	});

	it("keeps a boundary with no block in between inside one text block, counting the model's own newline", () => {
		const partial = createPartial();
		const textDeltas: string[] = [];
		const coordinator = createCoordinator(partial, undefined, textDeltas);

		// Captured SDK deltas: "Checking", "\n", assistantMessage step, "Done: Zebra-4821".
		coordinator.handleDelta({ type: "text-delta", text: "Checking" } as any);
		coordinator.handleDelta({ type: "text-delta", text: "\n" } as any);
		coordinator.handleStep({ type: "assistantMessage" });
		coordinator.handleDelta({ type: "text-delta", text: "Done: Zebra-4821" } as any);
		coordinator.flushText([]);

		expect(contentShape(partial)).toEqual([["text", "Checking\n\nDone: Zebra-4821"]]);
		expect(printModeStdout(partial)).toBe("Checking\n\nDone: Zebra-4821\n");
		expect(textDeltas.join("")).toBe("Checking\n\nDone: Zebra-4821");
	});

	it("adds no separator-only text block when a trace closed the previous text", () => {
		// Live-run shape: message, tool trace rendered as thinking, next message. With and
		// without the model's own trailing newline on the first message.
		const cases = [
			{ firstDeltas: ["Checking", "\n"], blocks: ["Checking\n", "Done: Zebra-4821"] },
			{ firstDeltas: ["Checking"], blocks: ["Checking", "\nDone: Zebra-4821"] },
		];
		for (const { firstDeltas, blocks } of cases) {
			const partial = createPartial();
			const emitter = new CursorPartialContentEmitter(createStream(), partial, -1, true);
			for (const delta of firstDeltas) emitter.appendTextDelta(delta);
			emitter.completeTextMessage();
			emitter.appendThinkingBlock("read note.txt\n\nZebra-4821");
			emitter.appendTextDelta("Done: Zebra-4821");
			emitter.closeAll();

			expect(contentShape(partial)).toEqual([["text", blocks[0]], ["thinking"], ["text", blocks[1]]]);
			expect(printModeStdout(partial)).toBe("Checking\n\nDone: Zebra-4821\n");
		}
	});
});
