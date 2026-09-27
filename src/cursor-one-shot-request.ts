import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
// Host constant, not a copy: omp routes this import to its own in-process pi-agent-core
// (pi-coding-agent extensibility/plugins/legacy-pi-compat.ts PI_PACKAGE_NAMES), so the
// comparison below uses the exact string the summarizer sends.
import { SUMMARIZATION_SYSTEM_PROMPT } from "@oh-my-pi/pi-agent-core/compaction/utils";

/**
 * omp tags side-channel requests (handoff documents, `/btw`, IRC and other ephemeral
 * turns) with a `<session>:side:<id>` provider session id so they never share a
 * provider's append-only conversation with the main turn, which may be mid-tool-call
 * (pi-coding-agent session/session-handoff.ts generateDocument, session/agent-session.ts
 * runEphemeralTurn).
 */
const HOST_SIDE_REQUEST_SESSION_MARKER = ":side:";

/**
 * True for a request that must run on a one-shot Cursor agent instead of the pooled
 * conversation agent, identified positively from the host's request shape:
 *
 * - the compaction and branch summarizer: its context is exactly
 *   `{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], … }` (pi-agent-core
 *   compaction/compaction.ts summarizeConversationWindow and the turn-prefix/short
 *   summaries, compaction/branch-summarization.ts);
 * - an omp side request (handoff document, `/btw`, ephemeral turns), by its session id.
 *
 * These requests never carry tool results for the pooled agent's live run, so skipping
 * the pre-send drain leaves that run intact for the turn that owns it; a live-run
 * continuation carries the session's own system prompt and session id and always stays
 * on the pool. A summarizer that arrives while a live run is waiting for tool results
 * (omp's mid-run compaction between provider calls) must go one-shot: on the pool it
 * would chain into that run and wait for tool results only the continuation brings.
 */
export function isCursorOneShotRequest(
	context: Pick<Context, "systemPrompt">,
	options?: Pick<SimpleStreamOptions, "sessionId">,
): boolean {
	const systemPrompt = context.systemPrompt;
	if (systemPrompt?.length === 1 && systemPrompt[0] === SUMMARIZATION_SYSTEM_PROMPT) return true;
	return options?.sessionId?.includes(HOST_SIDE_REQUEST_SESSION_MARKER) === true;
}
