import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentUsage, GetUsageOptions, RunUsage, SDKAgent, TokenUsage } from "@cursor/sdk";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { calculateContextTokens, calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import { findRequestUsageAnchor } from "@oh-my-pi/pi-agent-core/compaction/transcript-tokens";
import {
	applyCursorUsage,
	estimateCursorContextTotalTokens,
	isCursorSdkBilledUsageSafe,
	isCursorSdkUsagePartitionSafe,
	type CursorSdkTurnUsage,
} from "../src/cursor-usage-accounting.js";
import { fetchCursorCloudBilledTurnUsage, selectCursorBilledTurnUsage } from "../src/cursor-sdk-billed-usage.js";
import { awaitFinalizeCursorRunOutcome } from "../src/cursor-provider-turn-finalize.js";
import { CursorRunFinalizer, type CursorRunFinalizerParams } from "../src/cursor-provider-run-finalizer.js";
import type { CursorProviderTurnPrepareResult } from "../src/cursor-provider-turn-types.js";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import { readCursorSdkBuildSource } from "./helpers/cursor-sdk-build-source.js";
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

interface BilledUsageContractFixture {
	provenance: { sdkPackage: string; sdkVersion: string; contractVerifiedSdkVersions: string[] };
	localGetUsageFailure: { errorName: string; code: string; status: number; message: string };
	localTurnEnded: Array<{ label: string; usage: CursorSdkTurnUsage; sdkRunUsageTotalTokens: number }>;
	cloudReusedAgent: { sendOrder: string[]; afterRun1: AgentUsage; afterRun2: AgentUsage };
	cloudProductionShape: {
		captures: Array<{
			label: string;
			sendRunId: string;
			immediate: { readMs: number; result: AgentUsage };
			retryAfter5s: { readMs: number; result: AgentUsage };
		}>;
	};
	documentedExamples: {
		getAgentUsage: { totalUsage: TokenUsage; runs: Array<{ runId: string; usage: TokenUsage }> };
		adminFilteredUsageEvents: { tokenUsage: CursorSdkTurnUsage[] };
	};
}

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/cursor-sdk-billed-usage-1.0.34.json", import.meta.url), "utf8"),
) as BilledUsageContractFixture;

const WINDOW = 128_000;
const CLOUD_AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";
const CLOUD_RUN_ID = "run-00000000-0000-0000-0000-000000000001";
const LOCAL_AGENT_ID = "agent-00000000-0000-0000-0000-000000000002";
// A local run's id is a client-minted `run-<uuid>` label (the SDK says getUsage() rejects it for a local agent).
const LOCAL_RUN_ID = "run-00000000-0000-0000-0000-000000000002";

// A whole-run row: 412,000 prompt-side tokens, which no single 128k window holds.
const WHOLE_RUN_ROW: CursorSdkTurnUsage = {
	inputTokens: 12_000,
	outputTokens: 4_000,
	cacheReadTokens: 360_000,
	cacheWriteTokens: 40_000,
};

// The production-shape capture: a fresh cloud agent, one run, getUsage({ runId }) right after run.wait().
const PRODUCTION_CAPTURES = fixture.cloudProductionShape.captures;
const FRESH_ROW: CursorSdkTurnUsage = turnOf(PRODUCTION_CAPTURES[0]!.immediate.result.runs[0]!.usage);

function context(): Context {
	return {
		systemPrompt: ["Be helpful."],
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

function modelWithWindow() {
	const model = makeModel();
	model.contextWindow = WINDOW;
	return model;
}

function turnOf(usage: CursorSdkTurnUsage | TokenUsage): CursorSdkTurnUsage {
	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function row(runId: string, usage: CursorSdkTurnUsage): RunUsage {
	return { runId, usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens } };
}

function agentUsage(runs: RunUsage[]): AgentUsage {
	return {
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
		runs,
	};
}

/** The usage of a message after production applied `billed` to it for a cloud turn (no local count, no estimate input). */
function cloudMessageWithBilled(billed: CursorSdkTurnUsage, model = modelWithWindow(), prompt = context(), sessionInputTokens = 0): AssistantMessage {
	const partial = makeAssistantMessage("Hello back.");
	applyCursorUsage(partial, model, prompt, sessionInputTokens, { runtime: "cloud", billed });
	return partial;
}

describe("installed Cursor SDK getUsage contract", () => {
	const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
	// Declaration comments wrap lines with ` * `; fold them so a sentence can be matched whole.
	const readDeclaration = (file: string) => readFileSync(join(sdkRoot, file), "utf8").replace(/\s*\n\s*(?:\*\s*)?/g, " ");

	it("was captured with, or re-verified against, the installed SDK version", () => {
		expect(fixture.provenance.sdkPackage).toBe("@cursor/sdk");
		expect(fixture.provenance.contractVerifiedSdkVersions).toContain(fixture.provenance.sdkVersion);
		// An SDK bump must re-check the getUsage declarations and mapper contract below, then record the version.
		expect(fixture.provenance.contractVerifiedSdkVersions).toContain(readInstalledPackageVersion("@cursor/sdk"));
	});

	it("declares the token fields the billed-usage copy reads and the run-id semantics the cloud selection relies on", () => {
		const agentTypes = readDeclaration("dist/esm/agent.d.ts");
		expect(agentTypes).toContain("getUsage(options?: GetUsageOptions): Promise<AgentUsage>");
		expect(agentTypes).toContain("runId?: string");
		expect(agentTypes).toContain(
			"Restrict the result to one cloud run or local turn. For cloud agents, pass a `run-<uuid>` run ID. For local agents, pass a usage UUID from a previous `getUsage().runs[].runId`; client-side `run-<uuid>` labels throw a `ConfigurationError`.",
		);
		expect(agentTypes).toContain(
			"Cloud agents return a per-run breakdown. Local agents return a per-turn breakdown whose entries are keyed by usage UUID.",
		);

		const usageTypes = readDeclaration("dist/esm/usage-types.d.ts");
		expect(usageTypes).toContain("export interface AgentUsage");
		expect(usageTypes).toContain("usage: TokenUsage");
		expect(usageTypes).toContain("runs: RunUsage[]");
		expect(usageTypes).toContain("runId: string");
		for (const field of copiedTokenFields) {
			expect(usageTypes).toContain(`${field}: number`);
		}
		expect(usageTypes).toContain(
			"The `run-<uuid>` run ID for a cloud agent, or the turn's usage UUID for a local agent. This is also the value accepted by `GetUsageOptions.runId`.",
		);
		expect(usageTypes).toContain("Per-run entries for cloud agents. Local agent entries are per-turn groups keyed by usage UUID.");
	});

	// getUsage() returns the Cloud Agents API rows with `runs[].id` renamed `runId`, and a cloud agent's run-id read is
	// a server-side filter (`?runId=`). Every shipped build (Node ESM/CJS chunks, the flat Bun build) must do both.
	for (const build of ["esm", "cjs", "bundled"] as const) {
		it(`maps the usage response and sends the run-id filter in the ${build} build`, () => {
			const source = readCursorSdkBuildSource(build);
			expect(source).toMatch(
				/\{usage:[\w$]+\.totalUsage,.{0,80}runs:[\w$]+\.runs\.map\(\(?[\w$]+\)?=>\(\{runId:[\w$]+\.id,usage:[\w$]+\.usage/,
			);
			expect(source).toMatch(
				/getAgentUsage\([\w$]+,[\w$]+\)\{return this\.request\(\{method:"GET",path:`\/v1\/agents\/\$\{[\w$]+\([\w$]+\)\}\/usage`,query:\{runId:[\w$]+\?\.runId\}\}\)\}/,
			);
			expect(source).toMatch(/this\.client\.getAgentUsage\(this\.agentId,[\w$]+\)/);
		});
	}
});

describe("documented getUsage rows", () => {
	const model = modelWithWindow();
	const documentedRuns = fixture.documentedExamples.getAgentUsage.runs;
	const adminRows = fixture.documentedExamples.adminFilteredUsageEvents.tokenUsage;

	it("are additive buckets: totalTokens is the sum of the four counts and cache reads can exceed input", () => {
		const { totalUsage } = fixture.documentedExamples.getAgentUsage;
		for (const { usage } of [...documentedRuns, { usage: totalUsage }]) {
			expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
		}
		// Get Agent Usage example: cacheRead 21300 above input 6320. Admin API usage event: cacheRead 11964 above input 126.
		const [documentedRun] = documentedRuns;
		expect(documentedRun!.usage.cacheReadTokens).toBeGreaterThan(documentedRun!.usage.inputTokens);
		expect(adminRows[0]!.cacheReadTokens).toBeGreaterThan(adminRows[0]!.inputTokens);
	});

	it("are copied into the spend buckets as reported, not partitioned like a raw turn-ended count", () => {
		for (const usage of [...documentedRuns.map(({ usage: tokens }) => turnOf(tokens)), ...adminRows]) {
			// The raw-turn partition check (input - cacheRead - cacheWrite >= 0) would reject these rows.
			expect(isCursorSdkUsagePartitionSafe(usage, model)).toBe(usage.cacheReadTokens + usage.cacheWriteTokens <= usage.inputTokens);
			expect(isCursorSdkBilledUsageSafe(usage, model)).toBe(true);

			const { usage: applied } = cloudMessageWithBilled(usage);
			expect(applied.input).toBe(usage.inputTokens);
			expect(applied.output).toBe(usage.outputTokens);
			expect(applied.cacheRead).toBe(usage.cacheReadTokens);
			expect(applied.cacheWrite).toBe(usage.cacheWriteTokens);
		}
		expect(isCursorSdkUsagePartitionSafe(turnOf(documentedRuns[0]!.usage), model)).toBe(false);
	});
});

describe("captured getUsage and turn-ended usage", () => {
	const model = modelWithWindow();
	const [cloudRun1, cloudRun2] = fixture.cloudReusedAgent.sendOrder as [string, string];

	it("records that every captured local getUsage call answered 403 feature_unavailable", () => {
		expect(fixture.localGetUsageFailure).toMatchObject({ errorName: "UnknownAgentError", code: "feature_unavailable", status: 403 });
	});

	it("records captured local turn-ended usage as a full-prompt partition whose SDK run total adds all four counts", () => {
		for (const sample of fixture.localTurnEnded) {
			const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = sample.usage;
			expect(cacheReadTokens + cacheWriteTokens).toBeLessThanOrEqual(inputTokens);
			// The SDK's own run total adds all four, which double counts the cached part of a raw turn-ended input.
			expect(sample.sdkRunUsageTotalTokens).toBe(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
		}
	});

	it("selects a captured cloud row by run id in either row order; captured rows sum to totalTokens but never have cache reads above input", () => {
		const { afterRun1, afterRun2 } = fixture.cloudReusedAgent;
		expect(afterRun2.runs.map((run) => run.runId)).toEqual(fixture.cloudReusedAgent.sendOrder);
		for (const { usage } of [...afterRun1.runs, afterRun2.runs[0]!]) {
			expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
			expect(usage.cacheReadTokens).toBeLessThan(usage.inputTokens);
		}
		// Selection by run id does not depend on row order or on the other rows.
		const reversed = { ...afterRun2, runs: [...afterRun2.runs].reverse() };
		for (const result of [afterRun2, reversed]) {
			expect(selectCursorBilledTurnUsage(result, cloudRun1)).toEqual(turnOf(afterRun2.runs[0]!.usage));
		}
		expect(selectCursorBilledTurnUsage(afterRun2, "run-not-in-the-result")).toBeUndefined();
	});

	it("never applies an all-zero row (a safe rule: the capture read a just-finished run as zeros on a reused agent)", () => {
		const zeroRow = turnOf(fixture.cloudReusedAgent.afterRun2.runs[1]!.usage);
		expect(selectCursorBilledTurnUsage(fixture.cloudReusedAgent.afterRun2, cloudRun2)).toEqual(zeroRow);
		expect(isCursorSdkBilledUsageSafe(zeroRow, model)).toBe(false);
		const partial = cloudMessageWithBilled(zeroRow, model, context(), 7);
		expect(partial.usage).toMatchObject({ input: 7, cacheRead: 0, cacheWrite: 0 });
		expect(partial.usage.contextTokens).toBeUndefined();
	});

	it("pins the production-shape captures: the first read right after run.wait() on a fresh agent was recorded and settled", async () => {
		expect(PRODUCTION_CAPTURES).toHaveLength(2);
		for (const { sendRunId, immediate, retryAfter5s } of PRODUCTION_CAPTURES) {
			expect(sendRunId.startsWith("run-")).toBe(true);
			expect(immediate.result.runs).toHaveLength(1);
			expect(immediate.result.runs[0]!.runId).toBe(sendRunId);
			// Recorded counts on the first read, and an identical row on the read about 5 s later.
			expect(isCursorSdkBilledUsageSafe(turnOf(immediate.result.runs[0]!.usage), model)).toBe(true);
			expect(retryAfter5s.result.runs).toEqual(immediate.result.runs);
			// Both reads finished inside the plugin's 5 s cap.
			expect(Math.max(immediate.readMs, retryAfter5s.readMs)).toBeLessThan(5_000);

			const getUsage = vi.fn(async () => immediate.result);
			const usage = await fetchCursorCloudBilledTurnUsage({ agent: { getUsage } as unknown as SDKAgent, runId: sendRunId });
			expect(usage).toEqual(turnOf(immediate.result.runs[0]!.usage));
			expect(getUsage).toHaveBeenCalledWith({ runId: sendRunId });
		}
	});
});

describe("a billed row that cannot be a message's spend buckets", () => {
	const model = modelWithWindow();

	it("falls back when its prompt side exceeds the window, which omp would classify as a context overflow", () => {
		// The hazard: omp's classifier reads input + cacheRead + cacheWrite above the window as authoritative overflow
		// whatever the stop reason, so a whole-run row copied verbatim would make a `stop` message an overflow.
		const verbatim = makeAssistantMessage("Hello back.");
		verbatim.usage = { ...verbatim.usage, input: 12_000, output: 4_000, cacheRead: 360_000, cacheWrite: 40_000, totalTokens: 416_000 };
		expect(verbatim.stopReason).toBe("stop");
		expect(AIError.isContextOverflow(verbatim, WINDOW)).toBe(true);

		expect(isCursorSdkBilledUsageSafe(WHOLE_RUN_ROW, model)).toBe(false);
		const applied = cloudMessageWithBilled(WHOLE_RUN_ROW, model, context(), 7);
		expect(AIError.isContextOverflow(applied, WINDOW)).toBe(false);
		// The turn keeps the usage it would have without a billed row.
		expect(applied.usage).toMatchObject({ input: 7, cacheRead: 0, cacheWrite: 0 });
		expect(applied.usage.contextTokens).toBeUndefined();
	});

	it("is applied when its prompt side is exactly the window and rejected one token above", () => {
		const atWindow: CursorSdkTurnUsage = { inputTokens: 8_000, outputTokens: 500, cacheReadTokens: 100_000, cacheWriteTokens: 20_000 };
		expect(atWindow.inputTokens + atWindow.cacheReadTokens + atWindow.cacheWriteTokens).toBe(WINDOW);
		expect(isCursorSdkBilledUsageSafe(atWindow, model)).toBe(true);
		const applied = cloudMessageWithBilled(atWindow, model);
		expect(applied.usage).toMatchObject({ input: 8_000, output: 500, cacheRead: 100_000, cacheWrite: 20_000 });
		expect(AIError.isContextOverflow(applied, WINDOW)).toBe(false);

		const aboveWindow = { ...atWindow, cacheWriteTokens: atWindow.cacheWriteTokens + 1 };
		expect(isCursorSdkBilledUsageSafe(aboveWindow, model)).toBe(false);
		expect(cloudMessageWithBilled(aboveWindow, model).usage.cacheRead).toBe(0);
	});

	it("is not window-bounded when the model has no window", () => {
		const unbounded = { ...makeModel(), contextWindow: null };
		expect(isCursorSdkBilledUsageSafe(WHOLE_RUN_ROW, unbounded)).toBe(true);
	});

	it("is not bounded by the response cap: a billed row's output is the run's, a raw turn-ended count's is one turn's", () => {
		const output = model.maxTokens! + 1;
		const billedRun: CursorSdkTurnUsage = { inputTokens: 30_000, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 };
		expect(isCursorSdkBilledUsageSafe(billedRun, model)).toBe(true);
		expect(cloudMessageWithBilled(billedRun, model).usage.output).toBe(output);
		expect(isCursorSdkUsagePartitionSafe(billedRun, model)).toBe(false);
	});

	it("is rejected when a count is negative or not finite", () => {
		const base = FRESH_ROW;
		expect(isCursorSdkBilledUsageSafe(base, model)).toBe(true);
		expect(isCursorSdkBilledUsageSafe({ ...base, inputTokens: -1 }, model)).toBe(false);
		expect(isCursorSdkBilledUsageSafe({ ...base, cacheReadTokens: Number.NaN }, model)).toBe(false);
		expect(isCursorSdkBilledUsageSafe({ ...base, outputTokens: Number.POSITIVE_INFINITY }, model)).toBe(false);
	});

	it("is ignored for a local turn, which keeps its raw turn-ended mapping", () => {
		const localTurn = fixture.localTurnEnded[2]!.usage;
		const partial = makeAssistantMessage("Hello back.");
		applyCursorUsage(partial, model, context(), 0, { runtime: "local", turn: localTurn, billed: FRESH_ROW });
		expect(partial.usage).toMatchObject({ input: 74, output: 44, cacheRead: 6_400, cacheWrite: 0, totalTokens: 6_518 });
		expect(partial.usage.contextTokens).toBeUndefined();
	});
});

describe("billed spend is not the context anchor", () => {
	const model = modelWithWindow();
	const billed = FRESH_ROW;
	const bucketSum = billed.inputTokens + billed.cacheReadTokens + billed.cacheWriteTokens;

	it("sets contextTokens to the occupancy so omp's anchor is the occupancy, not the billed buckets", () => {
		const prompt = context();
		const partial = cloudMessageWithBilled(billed, model, prompt);
		const { usage } = partial;

		expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(bucketSum);
		expect(usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, prompt));
		expect(usage.contextTokens).toBe(usage.totalTokens);
		expect(usage.totalTokens).toBeGreaterThan(0);
		// Without contextTokens omp would take the bucket sum (14,526) as the prompt.
		expect(usage.totalTokens).toBeLessThan(bucketSum);
		expect(calculatePromptTokens(usage)).toBe(usage.totalTokens);
		expect(calculateContextTokens(usage)).toBe(usage.totalTokens);
		expect(findRequestUsageAnchor([...prompt.messages, partial])?.tokens).toBe(usage.totalTokens);
	});

	it("does not keep a stale contextTokens when usage is re-applied on the same partial without a billed row", () => {
		const prompt = context();
		const localTurn = fixture.localTurnEnded[2]!.usage;
		const partial = cloudMessageWithBilled(billed, model, prompt);
		expect(partial.usage.contextTokens).toBeDefined();

		applyCursorUsage(partial, model, prompt, 50, { runtime: "cloud" });
		expect("contextTokens" in partial.usage).toBe(false);
		expect(partial.usage).toMatchObject({ input: 50, cacheRead: 0, cacheWrite: 0 });

		applyCursorUsage(partial, model, prompt, 0, { runtime: "cloud", billed });
		expect(partial.usage.contextTokens).toBeDefined();
		applyCursorUsage(partial, model, prompt, 0, { runtime: "local", turn: localTurn });
		expect("contextTokens" in partial.usage).toBe(false);
		// Local turn-ended buckets partition the prompt, so omp's bucket sum is the prompt.
		expect(calculatePromptTokens(partial.usage)).toBe(localTurn.inputTokens);

		applyCursorUsage(partial, model, prompt, 0, { runtime: "cloud", billed });
		expect(partial.usage.contextTokens).toBeDefined();
		applyCursorUsage(partial, model, prompt, 9);
		expect("contextTokens" in partial.usage).toBe(false);
		expect(partial.usage.input).toBe(9);
	});

	it("never reports less occupancy than the newest same-model in-window assistant measurement", () => {
		const earlier = makeAssistantMessage("Earlier answer.", 2);
		earlier.usage = { ...earlier.usage, totalTokens: 50_000 };
		// A later measurement that does not fit the window is not an anchor.
		const outOfWindow = makeAssistantMessage("Out of window.", 4);
		outOfWindow.usage = { ...outOfWindow.usage, totalTokens: WINDOW + 1 };
		const prompt: Context = {
			systemPrompt: ["Be helpful."],
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				earlier,
				{ role: "user", content: "More", timestamp: 3 },
				outOfWindow,
				{ role: "user", content: "And more", timestamp: 5 },
			],
		};

		const partial = cloudMessageWithBilled(billed, model, prompt);
		expect(estimateCursorContextTotalTokens(partial, model, prompt)).toBeLessThan(50_000);
		expect(partial.usage.totalTokens).toBe(50_000);
		expect(partial.usage.contextTokens).toBe(50_000);
		expect(calculatePromptTokens(partial.usage)).toBe(50_000);
	});
});

describe("fetchCursorCloudBilledTurnUsage", () => {
	function agentReplying(reply: (options?: GetUsageOptions) => Promise<unknown>) {
		const getUsage = vi.fn(reply);
		return { agent: { getUsage } as unknown as SDKAgent, getUsage };
	}
	const documentedRuns = fixture.documentedExamples.getAgentUsage.runs;

	it("reads one cloud run by its id and returns that run's counts whatever the order or the other rows", async () => {
		const [newest, oldest] = documentedRuns as [RunUsage, RunUsage];
		const target = row(CLOUD_RUN_ID, turnOf(oldest.usage));
		for (const runs of [
			[newest, target],
			[target, newest],
		]) {
			const { agent, getUsage } = agentReplying(async () => agentUsage(runs));
			expect(await fetchCursorCloudBilledTurnUsage({ agent, runId: CLOUD_RUN_ID })).toEqual(turnOf(oldest.usage));
			expect(getUsage).toHaveBeenCalledTimes(1);
			expect(getUsage).toHaveBeenCalledWith({ runId: CLOUD_RUN_ID });
		}
	});

	it("does not read without a cloud run-shaped id", async () => {
		const { agent, getUsage } = agentReplying(async () => agentUsage([]));
		expect(await fetchCursorCloudBilledTurnUsage({ agent, runId: "not-a-run-id" })).toBeUndefined();
		expect(await fetchCursorCloudBilledTurnUsage({ agent, runId: "" })).toBeUndefined();
		expect(getUsage).not.toHaveBeenCalled();
	});

	it("returns nothing, without throwing, when the read fails or has no usable row for the run", async () => {
		const unusable = [
			async () => {
				throw new Error("billing down");
			},
			async () => undefined,
			async () => ({ usage: agentUsage([]).usage }),
			async () => agentUsage([]),
			async () => agentUsage([row("run-someone-else", turnOf(documentedRuns[0]!.usage))]),
			async () => ({ runs: [{ runId: CLOUD_RUN_ID, usage: { inputTokens: "many" } }] }),
		];
		for (const reply of unusable) {
			const { agent, getUsage } = agentReplying(reply);
			expect(await fetchCursorCloudBilledTurnUsage({ agent, runId: CLOUD_RUN_ID })).toBeUndefined();
			expect(getUsage).toHaveBeenCalledTimes(1);
		}
	});

	it("returns nothing when getUsage throws synchronously or the agent has none", async () => {
		const throwing = {
			getUsage: () => {
				throw new Error("getUsage is not usable");
			},
		} as unknown as SDKAgent;
		expect(await fetchCursorCloudBilledTurnUsage({ agent: throwing, runId: CLOUD_RUN_ID })).toBeUndefined();
		expect(await fetchCursorCloudBilledTurnUsage({ agent: {} as SDKAgent, runId: CLOUD_RUN_ID })).toBeUndefined();
	});

	it("gives up on a read that never settles once the timeout passes, without throwing", async () => {
		const { agent, getUsage } = agentReplying(() => new Promise<never>(() => {}));
		const startedAt = Date.now();
		expect(await fetchCursorCloudBilledTurnUsage({ agent, runId: CLOUD_RUN_ID, timeoutMs: 25 })).toBeUndefined();
		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});
});

describe("billed usage through the provider turn (finalize, then the run finalizer)", () => {
	const model = modelWithWindow();
	const prompt = context();

	async function runTurn(options: {
		runtime: "cloud" | "local";
		runId?: string;
		status?: "finished" | "error";
		reply?: (options?: GetUsageOptions) => Promise<unknown>;
		localTurn?: CursorSdkTurnUsage;
	}) {
		const { runtime, status = "finished" } = options;
		const agentId = runtime === "cloud" ? CLOUD_AGENT_ID : LOCAL_AGENT_ID;
		const runId = options.runId ?? (runtime === "cloud" ? CLOUD_RUN_ID : LOCAL_RUN_ID);
		const getUsage = vi.fn(options.reply ?? (async () => agentUsage([])));
		const turnCoordinator = {
			planTextCandidate: undefined,
			lastSdkTurnUsage: options.localTurn,
			discardIncompleteStartedToolCalls: vi.fn(),
			closeTraceBlock: vi.fn(),
			flushText: vi.fn(),
		};
		const prepared = {
			runtimeTarget: runtime,
			agent: { agentId, getUsage, listArtifacts: vi.fn().mockResolvedValue([]) },
			cwd: process.cwd(),
			payload: { text: "hello" },
			meta: { promptInputTokens: 7, bootstrap: true },
			contextWindowAgentId: agentId,
			textDeltas: [],
			lifecycle: { commitSend: vi.fn(), abandon: vi.fn(async () => {}), dispose: vi.fn(async () => {}), trackRunCompletion: vi.fn() },
			runtime: { kind: "direct", turnCoordinator },
			...(runtime === "local" ? { sessionAgentScopeKey: "scope", sessionAgentLease: { store: {} } } : {}),
		} as unknown as CursorProviderTurnPrepareResult;

		const finalized = await awaitFinalizeCursorRunOutcome({
			run: { id: runId, agentId, wait: vi.fn() } as unknown as Awaited<ReturnType<SDKAgent["send"]>>,
			prepared,
			cursorAgentMessageOffset: undefined,
			modelId: "composer-2.5",
			waitResult: status === "finished" ? { id: runId, status, result: "done" } : { id: runId, status },
			cacheContextWindow: false,
		});

		const partial = makeAssistantMessage("done");
		const stream = { push: vi.fn() };
		const finalizer = new CursorRunFinalizer({
			runnerParams: { model, context: prompt, stream, partial, sdkEventDebugRef: { current: undefined } },
			sdkEventDebug: () => undefined,
			sdkProcessErrorGuard: { dispose() {}, suppressAbortErrors() {} },
			resolvedApiKey: () => undefined,
			runtimeTarget: () => runtime,
		} as unknown as CursorRunFinalizerParams);
		await finalizer.applyTerminalEvent({
			kind: "direct",
			prepared,
			outcome: finalized.outcome,
			displayOnlyTraceBlock: finalized.displayOnlyTraceBlock,
		});
		const billedTurnUsage = prepared.runtimeTarget === "cloud" ? prepared.runtime.billedTurnUsage : undefined;
		return { partial, prepared, billedTurnUsage, getUsage };
	}

	it("puts a finished cloud turn's captured billed row in the spend buckets and the occupancy in contextTokens", async () => {
		for (const capture of PRODUCTION_CAPTURES) {
			const captured = capture.immediate.result.runs[0]!.usage;
			const { partial, billedTurnUsage, getUsage } = await runTurn({
				runtime: "cloud",
				runId: capture.sendRunId,
				reply: async () => capture.immediate.result,
			});

			expect(getUsage).toHaveBeenCalledTimes(1);
			expect(getUsage).toHaveBeenCalledWith({ runId: capture.sendRunId });
			expect(billedTurnUsage).toEqual(turnOf(captured));
			const { usage } = partial;
			expect(usage).toMatchObject({
				input: captured.inputTokens,
				output: captured.outputTokens,
				cacheRead: captured.cacheReadTokens,
				cacheWrite: captured.cacheWriteTokens,
			});
			expect(usage.contextTokens).toBe(usage.totalTokens);
			expect(usage.totalTokens).toBe(estimateCursorContextTotalTokens(partial, model, prompt));
			expect(calculatePromptTokens(usage)).toBe(usage.totalTokens);
			expect(usage.totalTokens).toBeLessThan(captured.inputTokens + captured.cacheReadTokens + captured.cacheWriteTokens);
		}
	});

	it("keeps an over-window cloud row off the message: the turn is not a context overflow", async () => {
		const { partial, billedTurnUsage, getUsage } = await runTurn({ runtime: "cloud", reply: async () => agentUsage([row(CLOUD_RUN_ID, WHOLE_RUN_ROW)]) });

		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(billedTurnUsage).toEqual(WHOLE_RUN_ROW);
		expect(partial.stopReason).toBe("stop");
		expect(AIError.isContextOverflow(partial, WINDOW)).toBe(false);
		expect(partial.usage).toMatchObject({ input: 7, cacheRead: 0, cacheWrite: 0 });
		expect(partial.usage.contextTokens).toBeUndefined();
	});

	it("keeps the turn's own usage when the billed read fails, returns zeros, or has no row for the run", async () => {
		const replies = [
			async () => {
				throw new Error("billing down");
			},
			async () => agentUsage([row(CLOUD_RUN_ID, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })]),
			async () => agentUsage([row("run-another", FRESH_ROW)]),
		];
		for (const reply of replies) {
			const { partial, getUsage } = await runTurn({ runtime: "cloud", reply });
			expect(getUsage).toHaveBeenCalledTimes(1);
			expect(partial.usage).toMatchObject({ input: 7, cacheRead: 0, cacheWrite: 0 });
			expect(partial.usage.contextTokens).toBeUndefined();
		}
	});

	it("does not read billed usage for a cloud turn that did not finish", async () => {
		const { partial, billedTurnUsage, getUsage } = await runTurn({ runtime: "cloud", status: "error", reply: async () => agentUsage([row(CLOUD_RUN_ID, FRESH_ROW)]) });
		expect(getUsage).not.toHaveBeenCalled();
		expect(billedTurnUsage).toBeUndefined();
		expect(partial.stopReason).toBe("error");
	});

	it("never calls getUsage for a local turn, even with a run-shaped id, and keeps its raw turn-ended usage", async () => {
		const localTurn = fixture.localTurnEnded[2]!.usage;
		const { partial, prepared, getUsage } = await runTurn({
			runtime: "local",
			localTurn,
			reply: async () => agentUsage([row(LOCAL_RUN_ID, FRESH_ROW)]),
		});

		expect(getUsage).not.toHaveBeenCalled();
		expect("billedTurnUsage" in prepared.runtime).toBe(false);
		expect(partial.usage).toMatchObject({ input: 74, output: 44, cacheRead: 6_400, cacheWrite: 0, totalTokens: 6_518 });
		expect(partial.usage.contextTokens).toBeUndefined();
		expect(calculatePromptTokens(partial.usage)).toBe(localTurn.inputTokens);
	});
});
