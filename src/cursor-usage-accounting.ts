import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import {
	CURSOR_APPROX_CHARS_PER_TOKEN,
	CURSOR_IMAGE_TOKEN_ESTIMATE,
	estimateCursorContextTokens,
	estimateCursorTextTokens,
	type CursorPromptOptions,
} from "./context.js";
import { asRecord, getNumber } from "./cursor-record-utils.js";
import type { CursorRuntime } from "./cursor-config.js";

export interface CursorUsagePromptOptions extends CursorPromptOptions {
	maxInputTokens: number;
	charsPerToken: number;
	imageTokenEstimate: number;
}

export interface CursorSdkTurnUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

function getPromptInputTokenBudget(model: Model<Api>): number {
	const contextWindow = model.contextWindow ?? 0;
	const maxTokens = model.maxTokens ?? Math.max(1, Math.floor(contextWindow * 0.8));
	const outputReserveTokens = Math.min(maxTokens, Math.max(1, Math.floor(contextWindow * 0.2)));
	return Math.max(1, contextWindow - outputReserveTokens);
}

export function getCursorPromptOptions(model: Model<Api>): CursorUsagePromptOptions {
	return {
		maxInputTokens: getPromptInputTokenBudget(model),
		charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN,
		imageTokenEstimate: CURSOR_IMAGE_TOKEN_ESTIMATE,
	};
}

function getNonNegativeTokenCount(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = getNumber(record, key);
	return value === undefined || value < 0 ? undefined : Math.floor(value);
}

export function readCursorSdkTurnUsage(value: unknown): CursorSdkTurnUsage | undefined {
	const record = asRecord(value);
	const inputTokens = getNonNegativeTokenCount(record, "inputTokens");
	const outputTokens = getNonNegativeTokenCount(record, "outputTokens");
	const cacheReadTokens = getNonNegativeTokenCount(record, "cacheReadTokens");
	const cacheWriteTokens = getNonNegativeTokenCount(record, "cacheWriteTokens");
	if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined;
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export function readCursorSdkTurnUsageFromUpdate(update: unknown): CursorSdkTurnUsage | undefined {
	const record = asRecord(update);
	return record?.type === "turn-ended" ? readCursorSdkTurnUsage(record.usage) : undefined;
}

function stringifyUsageValue(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

export function estimateCursorAssistantSessionOutputTokens(message: AssistantMessage): number {
	const parts = message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "toolCall") {
				return `Tool call (${block.name}, call ${block.id}): ${stringifyUsageValue(block.arguments)}`;
			}
			return "";
		})
		.filter(Boolean);
	return estimateCursorTextTokens(parts.join("\n"), { charsPerToken: CURSOR_APPROX_CHARS_PER_TOKEN });
}

function withAssistantMessage(context: Context, partial: AssistantMessage): Context {
	return { ...context, messages: [...context.messages, partial] };
}

export function estimateCursorContextTotalTokens(partial: AssistantMessage, model: Model<Api>, context: Context): number {
	return estimateCursorContextTokens(withAssistantMessage(context, partial), getCursorPromptOptions(model));
}

function getCursorSdkUncachedInputTokens(turnUsage: CursorSdkTurnUsage): number {
	// Observed raw local turn-ended.usage: inputTokens is the full prompt; cache fields partition it.
	// Published SDK toTokenUsage instead sums all four into totalTokens — do not use that transform here.
	return turnUsage.inputTokens - turnUsage.cacheReadTokens - turnUsage.cacheWriteTokens;
}

function hasNonNegativeFiniteCounts(turnUsage: CursorSdkTurnUsage): boolean {
	const counts = [turnUsage.inputTokens, turnUsage.outputTokens, turnUsage.cacheReadTokens, turnUsage.cacheWriteTokens];
	return counts.every((count) => Number.isFinite(count) && count >= 0);
}

/**
 * False for an all-zero count. The Cloud Agents API documents that "runs without any recorded token usage report
 * zeros across all fields" (such a run still appears in `runs`), and a capture on a reused cloud agent read a
 * just-finished run as zeros while an earlier run's row had grown. Zeros therefore mean "not billed yet", never
 * "this turn cost nothing". A safe rule: the production-shape reads (a fresh agent, `getUsage({ runId })` right after
 * `wait()`) returned recorded rows both times they were captured, so it has not been seen to trigger there.
 */
function isCursorSdkTokenUsageRecorded(turnUsage: CursorSdkTurnUsage): boolean {
	return turnUsage.inputTokens > 0 || turnUsage.outputTokens > 0 || turnUsage.cacheReadTokens > 0 || turnUsage.cacheWriteTokens > 0;
}

export function isCursorSdkUsagePartitionSafe(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	const uncachedInput = getCursorSdkUncachedInputTokens(turnUsage);
	return (
		hasNonNegativeFiniteCounts(turnUsage) &&
		(model.maxTokens === null || turnUsage.outputTokens <= model.maxTokens) &&
		Number.isFinite(uncachedInput) &&
		uncachedInput >= 0
	);
}

/**
 * Whether a billed getUsage() row may fill the message's spend buckets. Besides plausible, recorded counts, its
 * `input + cacheRead + cacheWrite` must fit the model's window: omp's overflow classifier
 * (`isUsageBackedContextOverflow`, pi-ai error/flags.ts) treats exactly that sum above the window as authoritative
 * overflow whatever the stop reason, and `checkCompaction` then drops the turn and compacts. A billed row is the
 * run's spend, which can exceed one context window with no window actually overflowing, so such a row falls back
 * to approximate usage. The output bound of a raw turn-ended count (`maxTokens`) does not apply: it is the
 * run's output, not one response's.
 */
export function isCursorSdkBilledUsageSafe(billed: CursorSdkTurnUsage, model: Model<Api>): boolean {
	return (
		hasNonNegativeFiniteCounts(billed) &&
		isCursorSdkTokenUsageRecorded(billed) &&
		(model.contextWindow === null || billed.inputTokens + billed.cacheReadTokens + billed.cacheWriteTokens <= model.contextWindow)
	);
}

export function isCursorSdkUsageSafeForPiMessage(turnUsage: CursorSdkTurnUsage, model: Model<Api>): boolean {
	return (
		isCursorSdkUsagePartitionSafe(turnUsage, model) &&
		(model.contextWindow === null || turnUsage.inputTokens + turnUsage.outputTokens <= model.contextWindow)
	);
}

export function applyCursorSdkUsage(partial: AssistantMessage, turnUsage: CursorSdkTurnUsage): void {
	// Pi treats input/cacheRead/cacheWrite as disjoint additive prompt components.
	partial.usage.input = getCursorSdkUncachedInputTokens(turnUsage);
	partial.usage.output = turnUsage.outputTokens;
	partial.usage.cacheRead = turnUsage.cacheReadTokens;
	partial.usage.cacheWrite = turnUsage.cacheWriteTokens;
	// totalTokens is context occupancy (full prompt + output), not the sum of spend components alone.
	partial.usage.totalTokens = turnUsage.inputTokens + turnUsage.outputTokens;
}

/**
 * Copy a billed getUsage() row into the spend buckets as reported. The Cloud Agents API that backs getUsage()
 * documents the four counts as additive buckets: `GET /v1/agents/{id}/usage` defines `totalTokens` as the sum of
 * the four, and both its example row (inputTokens 6320, cacheReadTokens 21300) and the Admin API
 * `filtered-usage-events` example (inputTokens 126, cacheReadTokens 11964) have cache reads above input. So
 * inputTokens is already the uncached input: subtracting the cache fields, as for a raw turn-ended count, would
 * understate it and reject such rows. This is documented, not captured: no captured row has cache reads above
 * input (see test/fixtures/cursor-sdk-billed-usage-1.0.34.json). Either way the buckets are the run's spend, not
 * the size of the context.
 */
function applyCursorSdkBilledUsage(partial: AssistantMessage, billed: CursorSdkTurnUsage): void {
	partial.usage.input = billed.inputTokens;
	partial.usage.output = billed.outputTokens;
	partial.usage.cacheRead = billed.cacheReadTokens;
	partial.usage.cacheWrite = billed.cacheWriteTokens;
}

function isCompatibleCursorAssistantMeasurement(assistant: AssistantMessage, model: Model<Api>): boolean {
	return assistant.api === model.api && assistant.provider === model.provider && assistant.model === model.id;
}

/**
 * Occupancy of the newest usable same-model assistant measurement, using the staleness
 * scan of pi-agent-core findRequestUsageAnchor (compaction/transcript-tokens.ts): walking
 * forward, a compaction/branch summary (a `user` message with `historyRewriteAt`; its
 * rewrite time is max(historyRewriteAt, timestamp)) or a pruned tool result (`prunedAt`)
 * raises the rewrite time, and only assistants after the rewrites seen so far qualify.
 * An assistant before a later pruned result stays valid; its prefix was not rewritten.
 * On top of the host rule, a measurement must come from this model and fit its window.
 */
function getLastAcceptedContextOccupancy(context: Context, model: Model<Api>): number {
	let rewriteAt = Number.NEGATIVE_INFINITY;
	let occupancy = 0;
	for (const message of context.messages) {
		if (message.role === "user" && message.historyRewriteAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.historyRewriteAt, message.timestamp);
			continue;
		}
		if (message.role === "toolResult" && message.prunedAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.prunedAt);
			continue;
		}
		if (message.role !== "assistant" || message.timestamp <= rewriteAt) continue;
		if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) continue;
		if (!isCompatibleCursorAssistantMeasurement(message, model)) continue;
		const { usage } = message;
		const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (Number.isFinite(total) && total > 0 && (model.contextWindow === null || total <= model.contextWindow)) {
			occupancy = total;
		}
	}
	return occupancy;
}

export function applyCursorApproximateUsage(partial: AssistantMessage, model: Model<Api>, context: Context, sessionInputTokens: number): void {
	const outputTokens = estimateCursorAssistantSessionOutputTokens(partial);
	partial.usage.input = Math.max(0, sessionInputTokens);
	partial.usage.output = outputTokens;
	partial.usage.cacheRead = 0;
	partial.usage.cacheWrite = 0;
	// Never report less occupancy than the last compatible same-model in-window assistant measurement.
	partial.usage.totalTokens = Math.max(
		partial.usage.input + partial.usage.output,
		estimateCursorContextTotalTokens(partial, model, context),
		getLastAcceptedContextOccupancy(context, model),
	);
}

export function applyCursorUsage(
	partial: AssistantMessage,
	model: Model<Api>,
	context: Context,
	sessionInputTokens: number,
	sdkUsage?: { runtime: CursorRuntime; turn?: CursorSdkTurnUsage; billed?: CursorSdkTurnUsage },
): void {
	// Billed getUsage() rows exist only for finished cloud turns: a local turn is never read (fetchCursorCloudBilledTurnUsage).
	const billed = sdkUsage?.runtime === "cloud" ? sdkUsage.billed : undefined;
	const localTurn = sdkUsage?.runtime === "local" ? sdkUsage.turn : undefined;
	// Start from an unset anchor: a partial that already carries a billed pass's `contextTokens` must not keep it
	// when this pass has no billed row, because its buckets then mean something else.
	delete partial.usage.contextTokens;
	// How omp reads a message: `calculatePromptTokens` (the /context anchor, compaction headroom, contextFitsModel)
	// is `usage.contextTokens` when set, else input + cacheRead + cacheWrite; `calculateContextTokens` is
	// `contextTokens` when set, else `totalTokens`.
	// - A billed row fills the buckets with the run's spend, so their sum is not the context. The occupancy (the
	//   estimate, which includes this turn's output because the next request's prefix carries it) goes into
	//   `contextTokens` as well as `totalTokens`, as omp's own Cursor provider does with the checkpoint's used tokens.
	// - A raw local turn needs no override: input + cacheRead + cacheWrite partition its full prompt.
	// - The approximate path's input is an estimate of what this send carried (only the new messages on an
	//   incremental send) and its cache buckets are 0, so its sum does not partition `totalTokens` either. It is
	//   left as it was: both numbers are estimates, and this change is about keeping billed spend out of the anchor.
	// Cent fields on AgentUsage are not copied; model rates are zero.
	if (billed && isCursorSdkBilledUsageSafe(billed, model)) {
		applyCursorSdkBilledUsage(partial, billed);
		const occupancy = Math.max(
			estimateCursorContextTotalTokens(partial, model, context),
			getLastAcceptedContextOccupancy(context, model),
		);
		partial.usage.totalTokens = occupancy;
		partial.usage.contextTokens = occupancy;
		return;
	}
	// Only local raw turn-ended usage has a captured full-prompt/cache-partition contract.
	// Cloud raw usage remains display-only until its field semantics are independently observed.
	if (localTurn && isCursorSdkUsageSafeForPiMessage(localTurn, model)) {
		applyCursorSdkUsage(partial, localTurn);
		return;
	}
	applyCursorApproximateUsage(partial, model, context, sessionInputTokens);
}
