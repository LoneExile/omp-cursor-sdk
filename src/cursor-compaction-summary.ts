import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { peekSessionCursorAgentSendState } from "./cursor-session-agent.js";
import { planCursorSessionSend } from "./cursor-session-send-policy.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";

/**
 * omp runs the compaction summarizer through the session side-stream, outside the agent
 * loop, and with async compaction concurrently with normal turns. The plugin keeps it off
 * the pooled conversation agent without registering `session_before_compact`, whose mere
 * presence disables omp's speculative compaction for every session in the process
 * (pi-coding-agent session-maintenance.ts: maybeStartSpeculativeCompaction and friends).
 *
 * `session.compacting` is emitted and awaited on every compaction path right before the
 * summarizer's LLM call (session-maintenance.ts #prepareCompactionFromHooks), and its
 * handlers disable nothing. It opens a window per session scope; `session_compact`
 * (success) or the next prompt's `before_agent_start` (failed or cancelled compaction)
 * closes it.
 */
const compactionSummaryScopes = new Set<string>();

type CursorCompactionSummaryExtensionApi = Pick<ExtensionAPI, "on">;

export function registerCursorCompactionSummaryWindow(pi: CursorCompactionSummaryExtensionApi): void {
	pi.on("session.compacting", () => {
		compactionSummaryScopes.add(getCursorSessionScopeKey());
		return undefined;
	});
	pi.on("session_compact", () => {
		compactionSummaryScopes.delete(getCursorSessionScopeKey());
	});
	pi.on("before_agent_start", () => {
		compactionSummaryScopes.delete(getCursorSessionScopeKey());
		return undefined;
	});
}

/**
 * True for a request that must run on a one-shot agent: a compaction summary is pending in
 * this scope and the request does not continue the pooled conversation (it would need a
 * bootstrap). Continuing turns that run concurrently with async compaction keep the pool.
 */
export function isCursorOneShotRequest(context: Context, scopeKey: string = getCursorSessionScopeKey()): boolean {
	if (!compactionSummaryScopes.has(scopeKey)) return false;
	const sendState = peekSessionCursorAgentSendState(scopeKey) ?? {
		bootstrapped: false,
		contextFingerprint: "",
		incrementalSendCount: 0,
	};
	return planCursorSessionSend(sendState, context).mode === "bootstrap";
}

export const __testUtils = {
	reset(): void {
		compactionSummaryScopes.clear();
	},
};
