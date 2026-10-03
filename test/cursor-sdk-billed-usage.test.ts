import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentUsage, GetUsageOptions, SDKAgent, TokenUsage } from "@cursor/sdk";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { estimateCursorContextTotalTokens } from "../src/cursor-usage-accounting.js";
import {
	__testUtils,
	copyCursorSdkBilledTokenTotals,
} from "../src/cursor-sdk-billed-usage.js";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import { makeModel } from "./helpers/model-fixtures.js";

const copiedTokenFields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
type _AssertCopiedTokenFields = Record<(typeof copiedTokenFields)[number], number> extends Pick<
	TokenUsage,
	(typeof copiedTokenFields)[number]
>
	? true
	: never;
const _copiedTokenFieldsPresent: _AssertCopiedTokenFields = true;
void _copiedTokenFieldsPresent;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const existingUsage: AssistantMessage["usage"] = {
	input: 11,
	output: 22,
	cacheRead: 33,
	cacheWrite: 44,
	totalTokens: 55,
	cost: zeroCost,
};

const turnA = {
	inputTokens: 25,
	outputTokens: 6,
	cacheReadTokens: 24,
	cacheWriteTokens: 1,
	totalTokens: 56,
} satisfies TokenUsage;
const turnB = {
	inputTokens: 30,
	outputTokens: 4,
	cacheReadTokens: 5,
	cacheWriteTokens: 1,
	totalTokens: 40,
} satisfies TokenUsage;

function context(): Context {
	return {
		systemPrompt: ["Be helpful."],
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

function partialWithExisting(text = "Hello back."): AssistantMessage {
	const partial = makeAssistantMessage(text);
	partial.usage = {
		...existingUsage,
		cost: { ...zeroCost },
	};
	return partial;
}

function agentUsage(runs: AgentUsage["runs"], usage: TokenUsage = turnA): AgentUsage {
	return {
		usage,
		cost: { rawCostCents: 12.5, chargedCents: 4 },
		runs,
	};
}

afterEach(() => {
	__testUtils.reset();
});

describe("installed Cursor SDK getUsage contract", () => {
	it("declares the token fields the billed-usage copy reads", () => {
		const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
		const agentTypes = readFileSync(join(sdkRoot, "dist/esm/agent.d.ts"), "utf8");
		expect(agentTypes).toContain("getUsage(options?: GetUsageOptions): Promise<AgentUsage>");
		expect(agentTypes).toContain("runId?: string");

		const usageTypes = readFileSync(join(sdkRoot, "dist/esm/usage-types.d.ts"), "utf8");
		expect(usageTypes).toContain("export interface AgentUsage");
		expect(usageTypes).toContain("usage: TokenUsage");
		expect(usageTypes).toContain("runs: RunUsage[]");
		expect(usageTypes).toContain("runId: string");
		for (const field of copiedTokenFields) {
			expect(usageTypes).toContain(`${field}: number`);
		}
	});
});

describe("cursor billed token totals", () => {
	it("copies getUsage token totals onto host usage and leaves existing usage unchanged when getUsage throws or is empty", async () => {
		const model = makeModel();
		model.cost = { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 };
		const prompt = context();
		const partial = partialWithExisting();
		const localTurn = { inputTokens: 40, outputTokens: 2, cacheReadTokens: 10, cacheWriteTokens: 0 };

		await copyCursorSdkBilledTokenTotals({
			agent: {
				getUsage: async (options?: GetUsageOptions) => {
					if (options?.runId?.startsWith("run-")) throw new Error("client-minted run id");
					return agentUsage([{ runId: "usage-a", usage: turnA, cost: { rawCostCents: 12.5, chargedCents: 4 } }]);
				},
			} as SDKAgent,
			agentId: "agent-copy",
			runtime: "local",
			runId: "run-local-1",
			partial,
			model,
			context: prompt,
			localTurn,
		});

		expect(partial.usage.input).toBe(0);
		expect(partial.usage.output).toBe(6);
		expect(partial.usage.cacheRead).toBe(24);
		expect(partial.usage.cacheWrite).toBe(1);
		expect(partial.usage.totalTokens).toBe(42);
		expect(partial.usage.cost).toEqual(zeroCost);

		const cloudPartial = partialWithExisting();
		await copyCursorSdkBilledTokenTotals({
			agent: {
				getUsage: async (options?: GetUsageOptions) => {
					if (options?.runId !== "run-cloud-1") {
						return agentUsage(
							[
								{ runId: "run-cloud-1", usage: turnA },
								{ runId: "run-other", usage: turnB },
							],
							{ inputTokens: 55, outputTokens: 10, cacheReadTokens: 29, cacheWriteTokens: 2, totalTokens: 96 },
						);
					}
					return agentUsage([{ runId: "run-cloud-1", usage: turnA }]);
				},
			} as SDKAgent,
			agentId: "agent-cloud",
			runtime: "cloud",
			runId: "run-cloud-1",
			partial: cloudPartial,
			model,
			context: prompt,
		});
		expect(cloudPartial.usage.input).toBe(0);
		expect(cloudPartial.usage.output).toBe(6);
		expect(cloudPartial.usage.cacheRead).toBe(24);
		expect(cloudPartial.usage.cacheWrite).toBe(1);
		expect(cloudPartial.usage.totalTokens).toBe(estimateCursorContextTotalTokens(cloudPartial, model, prompt));
		expect(cloudPartial.usage.cost).toEqual(zeroCost);

		const second = partialWithExisting();
		await copyCursorSdkBilledTokenTotals({
			agent: {
				getUsage: async () =>
					agentUsage([
						{ runId: "usage-a", usage: turnA },
						{ runId: "usage-b", usage: turnB },
					]),
			} as SDKAgent,
			agentId: "agent-copy",
			runtime: "local",
			partial: second,
			model,
			context: prompt,
			localTurn,
		});
		expect(second.usage.input).toBe(24);
		expect(second.usage.output).toBe(4);
		expect(second.usage.cacheRead).toBe(5);
		expect(second.usage.cacheWrite).toBe(1);
		expect(second.usage.totalTokens).toBe(42);
		expect(second.usage.cost).toEqual(zeroCost);

		for (const getUsage of [
			async () => {
				throw new Error("billing down");
			},
			async () =>
				({
					usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
					runs: [],
				}) satisfies AgentUsage,
			async () => undefined,
		]) {
			const unchanged = partialWithExisting();
			await copyCursorSdkBilledTokenTotals({
				agent: { getUsage } as unknown as SDKAgent,
				agentId: "agent-empty",
				runtime: "local",
				partial: unchanged,
				model,
				context: prompt,
			});
			expect(unchanged.usage).toEqual(existingUsage);
		}
	});
});
