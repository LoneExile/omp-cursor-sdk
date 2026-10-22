import type { RunError, RunResult } from "@cursor/sdk";
import { selectCursorFinalText } from "./cursor-run-final-text.js";
import {
	formatCursorSdkAbortMessage,
	formatCursorSdkRunFailureDetail,
	resolveCursorSdkAbortCause,
	sanitizeCursorProviderError,
} from "./cursor-provider-errors.js";
import type { CursorRuntime } from "./cursor-config.js";
import { hasUsableText } from "./cursor-record-utils.js";
import {
	buildIncompleteCursorToolRunOutcome,
	type IncompleteCursorToolRunOutcome,
} from "./cursor-incomplete-tool-visibility.js";

/** Unified SDK wait() facts consumed by live and direct emission strategies. */
export type CursorRunOutcome =
	| {
			kind: "finished";
			waitResult: RunResult;
			finalText: string;
			incompleteTools: IncompleteCursorToolRunOutcome;
			assistantTextProduced: boolean;
	  }
	| {
			kind: "cancelled";
			waitResult: RunResult;
			incompleteTools: IncompleteCursorToolRunOutcome;
			abortMessage: string;
	  }
	| {
			kind: "error";
			waitResult: RunResult;
			incompleteTools: IncompleteCursorToolRunOutcome;
			errorMessage: string;
	  };

export interface ResolveCursorRunOutcomeParams {
	waitResult: RunResult;
	signalAborted?: boolean;
	textDeltas: readonly string[];
	emittedText: string;
	planTextCandidate?: string;
	selectFinalTextOptions?: { allowPartialPrefix?: boolean };
	runResultFallback?: string;
	runErrorFallback?: RunError;
	resolvedApiKey?: string;
	optionsApiKey?: string;
	runtimeTarget: CursorRuntime;
}

function hasCursorAssistantText(
	resultText: unknown,
	textDeltas: readonly string[],
	fallbackText?: string,
): boolean {
	return (
		hasUsableText(typeof resultText === "string" ? resultText : undefined) ||
		hasUsableText(textDeltas.join("")) ||
		hasUsableText(fallbackText)
	);
}

export function isCursorRunFinishedSuccessfully(outcome: CursorRunOutcome): boolean {
	return outcome.kind === "finished";
}

function buildCursorRunAbortMessage(signalAborted: boolean | undefined, sdkStatusCancelled: boolean): string {
	return formatCursorSdkAbortMessage(
		resolveCursorSdkAbortCause({
			signalAborted,
			sdkStatusCancelled,
		}),
	);
}

export function resolveCursorRunOutcome(params: ResolveCursorRunOutcomeParams): CursorRunOutcome {
	const { waitResult, signalAborted } = params;
	const sdkCancelled = waitResult.status === "cancelled";
	const callerAborted = signalAborted === true;

	if (callerAborted || sdkCancelled) {
		const incompleteTools = buildIncompleteCursorToolRunOutcome({
			status: "cancelled",
			signalAborted: callerAborted,
			assistantTextProduced: false,
		});
		return {
			kind: "cancelled",
			waitResult,
			incompleteTools,
			abortMessage: buildCursorRunAbortMessage(callerAborted, sdkCancelled),
		};
	}

	if (waitResult.status === "error") {
		const failureDetail = formatCursorSdkRunFailureDetail(
			waitResult,
			params.runResultFallback,
			params.runErrorFallback,
			params.runtimeTarget,
		);
		return {
			kind: "error",
			waitResult,
			incompleteTools: buildIncompleteCursorToolRunOutcome({
				status: "error",
				assistantTextProduced: false,
			}),
			errorMessage: sanitizeCursorProviderError(
				failureDetail,
				params.resolvedApiKey ?? params.optionsApiKey,
				params.runtimeTarget,
			),
		};
	}

	const assistantTextProduced = hasCursorAssistantText(
		waitResult.result,
		params.textDeltas,
		params.planTextCandidate,
	);
	const incompleteTools = buildIncompleteCursorToolRunOutcome({
		status: waitResult.status,
		assistantTextProduced,
	});
	const finalText = selectCursorFinalText(
		waitResult.result,
		params.textDeltas,
		params.emittedText,
		params.planTextCandidate,
		params.selectFinalTextOptions,
	);

	return {
		kind: "finished",
		waitResult,
		finalText,
		incompleteTools,
		assistantTextProduced,
	};
}

export type CursorRunEmission = "finished" | "cancelled" | "failed";

export function classifyCursorRunEmission(outcome: CursorRunOutcome): CursorRunEmission {
	switch (outcome.kind) {
		case "finished":
			return "finished";
		case "cancelled":
			return "cancelled";
		case "error":
			return "failed";
	}
}

export function getCursorRunAbortMessage(outcome: CursorRunOutcome): string {
	if (outcome.kind === "cancelled") return outcome.abortMessage;
	return buildCursorRunAbortMessage(false, outcome.waitResult.status === "cancelled");
}
