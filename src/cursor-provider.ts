import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import {
	cursorLiveRuns,
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	getPendingCursorLiveRun,
	hasTrailingUserMessagesAfterToolResults,
	releaseAllPendingCursorLiveRunsForTests,
	resetCursorNativeReplayIdleDisposeMs,
	setCursorNativeReplayIdleDisposeMs,
} from "./cursor-provider-live-run-drain.js";
import { disposeAllSessionCursorAgents } from "./cursor-session-agent.js";
import { attachCursorSdkEventDebugPiStreamTap, type CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { sanitizeCursorProviderError } from "./cursor-provider-errors.js";
import { rewriteCursorOverflowAssistantMessage } from "./cursor-provider-overflow.js";
import { resolveCursorApiKey, resolveCursorStringApiKeySync } from "./cursor-api-key.js";
import { CursorProviderTurnRunner } from "./cursor-provider-turn-runner.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import { sessionAgentEntryKey } from "./cursor-session-agent.js";
import { classifyCursorRequestRoute } from "./cursor-one-shot-request.js";
import {
	createDetachedCursorSessionBinding,
	resolveCursorRequestBinding,
	runInCursorSessionBinding,
	type CursorRequestResolution,
	type CursorSessionStream,
} from "./cursor-session-binding.js";
import { runExclusiveCursorSessionTurn, __testUtils as cursorSessionTurnQueueTestUtils } from "./cursor-session-turn-queue.js";

function makeInitialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const resolution = resolveCursorRequestBinding(options, context);
	// The module instance that owns the session runs the request; this instance may only
	// have registered the api last (see cursor-session-binding.ts).
	return (resolution.binding?.stream ?? streamCursorInBinding)(resolution, model, context, options);
}

/**
 * This module instance's entry for a request of one of its sessions (a binding's
 * `stream`). The whole turn, including its fire-and-forget run completion, runs in that
 * session; a request no session can be told for runs one-shot outside every session.
 */
export const streamCursorInBinding: CursorSessionStream = (resolution, model, context, options) => {
	const binding = resolution.binding ?? createDetachedCursorSessionBinding();
	return runInCursorSessionBinding(binding, () => streamCursorInSession(model, context, options, resolution));
};

function streamCursorInSession(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	resolution: CursorRequestResolution,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const sdkEventDebugRef: { current?: CursorSdkEventDebugSink } = {};
	attachCursorSdkEventDebugPiStreamTap(stream, sdkEventDebugRef);

	(async () => {
		const partial = makeInitialMessage(model);
		const route = classifyCursorRequestRoute(context, options, resolution);

		const runner = new CursorProviderTurnRunner({
			model,
			context,
			stream,
			partial,
			options,
			sdkEventDebugRef,
			route,
		});

		try {
			stream.push({ type: "start", partial });
			// Turns of one pooled conversation run one at a time; a one-shot request runs
			// on its own agent and waits for nothing.
			await (route.oneShot
				? runner.run(installCursorSdkProcessErrorGuard())
				: runExclusiveCursorSessionTurn(
					sessionAgentEntryKey(getCursorSessionScopeKey(), route.conversationId),
					() => runner.run(installCursorSdkProcessErrorGuard()),
					options?.signal,
				));
		} catch (error) {
			await runner.handleOuterCatch(error);
		}

		stream.end();
	})().catch((error: unknown) => {
		const partial = makeInitialMessage(model);
		partial.stopReason = "error";
		partial.errorMessage = sanitizeCursorProviderError(error, resolveCursorStringApiKeySync(options?.apiKey));
		// Terminal-error normalization also lives here (not just
		// pushTerminalError) so a failure routed through the outer catch
		// still rewrites Cursor context-overflow into context_length_exceeded.
		const rewritten = rewriteCursorOverflowAssistantMessage(partial, true);
		if (rewritten) Object.assign(partial, rewritten);
		stream.push({ type: "error", reason: "error", error: partial });
		stream.end();
	});

	return stream;
}

export const __testUtils = {
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	pendingCursorNativeRunCount: cursorLiveRuns.count,
	getPendingCursorLiveRun,
	getActiveCursorLiveRunForScope: cursorLiveRuns.getActiveForScope,
	hasTrailingUserMessagesAfterToolResults,
	setCursorNativeReplayIdleDisposeMs,
	resetCursorNativeReplayIdleDisposeMs,
	releaseAllPendingCursorLiveRunsForTests,
	resetSessionCursorAgents: () => disposeAllSessionCursorAgents(),
	resetSessionTurnQueue: cursorSessionTurnQueueTestUtils.reset,
};
