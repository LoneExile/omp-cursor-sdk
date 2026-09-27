import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent";
import { applyCursorApproximateUsage, estimateCursorContextTotalTokens } from "../src/cursor-usage-accounting.js";
import { makeModel } from "./helpers/model-fixtures.js";

const model = { ...makeModel("composer-2.5"), contextWindow: 300_000 };
const COMPACTED_AT = 10_000;

function cursorAssistant(text: string, timestamp: number, totalTokens = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

// The provider request OMP builds after a compaction: the host's own convertToLlm turns the
// compactionSummary into a `user` message (attribution "agent", historyRewriteAt), followed by
// the kept pre-compaction tail and the new prompt.
function postCompactionContext(extra: Context["messages"] = []): Context {
	const agentMessages = [
		{ role: "compactionSummary", summary: "Earlier work: refactored the parser.", tokensBefore: 240_000, timestamp: COMPACTED_AT },
		{ role: "user", content: "Keep going with the parser.", timestamp: 1_000 },
		cursorAssistant("Parser refactor is half done.", 2_000, 235_278),
		...extra,
		{ role: "user", content: "Now add tests.", timestamp: 11_000 },
	];
	return { systemPrompt: ["Be helpful."], messages: convertToLlm(agentMessages as Parameters<typeof convertToLlm>[0]) };
}

describe("Cursor usage after OMP compaction (#204)", () => {
	it("pins the host's post-compaction summary shape", () => {
		const [summary] = postCompactionContext().messages;
		expect(summary).toMatchObject({ role: "user", attribution: "agent", historyRewriteAt: COMPACTED_AT });
	});

	it("does not raise occupancy to a kept pre-compaction assistant's usage", () => {
		const context = postCompactionContext();
		const partial = cursorAssistant("Added tests.", 12_000);
		applyCursorApproximateUsage(partial, model, context, 500);

		const expected = Math.max(partial.usage.input + partial.usage.output, estimateCursorContextTotalTokens(partial, model, context));
		expect(partial.usage.totalTokens).toBe(expected);
		expect(partial.usage.totalTokens).toBeLessThan(10_000);
	});

	it("still floors occupancy at usage measured after the compaction", () => {
		const context = postCompactionContext([
			{ role: "user", content: "Run the suite.", timestamp: 10_500 },
			cursorAssistant("Suite is green.", 10_600, 42_000),
		]);
		const partial = cursorAssistant("Added tests.", 12_000);
		applyCursorApproximateUsage(partial, model, context, 500);

		expect(partial.usage.totalTokens).toBe(42_000);
	});

	// Tool-output pruning rewrites a toolResult in place and stamps `prunedAt`
	// (pi-agent-core compaction/pruning.ts, shake.ts); host findRequestUsageAnchor
	// treats usage reported at or before it as stale.
	it("does not raise occupancy to usage reported before a tool result was pruned", () => {
		const PRUNED_AT = 9_000;
		const toolCallTurn: AssistantMessage = {
			...cursorAssistant("", 2_000, 150_000),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "big.log" } }],
			stopReason: "toolUse",
		};
		const agentMessages = [
			{ role: "user", content: "Summarize big.log.", timestamp: 1_000 },
			toolCallTurn,
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], isError: false, prunedAt: PRUNED_AT, timestamp: 2_100 },
			cursorAssistant("The log shows retries.", 3_000, 180_000),
			{ role: "user", content: "Anything else?", timestamp: 11_000 },
		];
		const context: Context = { systemPrompt: ["Be helpful."], messages: convertToLlm(agentMessages as Parameters<typeof convertToLlm>[0]) };
		expect(context.messages[2]).toMatchObject({ role: "toolResult", prunedAt: PRUNED_AT });

		const partial = cursorAssistant("Nothing else.", 12_000);
		applyCursorApproximateUsage(partial, model, context, 500);
		expect(partial.usage.totalTokens).toBe(
			Math.max(partial.usage.input + partial.usage.output, estimateCursorContextTotalTokens(partial, model, context)),
		);
		expect(partial.usage.totalTokens).toBeLessThan(10_000);
	});
});
