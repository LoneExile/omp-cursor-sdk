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

type CursorRequestRoutingOptions = Pick<SimpleStreamOptions, "sessionId" | "providerSessionState">;

/**
 * True for a request that must run on a one-shot Cursor agent instead of the pooled
 * conversation agent. Only an agent-loop turn continues the pooled conversation, and omp
 * marks those positively: every loop provider call carries the session's
 * `providerSessionState` store (pi-agent-core agent.ts loop config; the store the host's
 * own providers keep per-conversation state in, e.g. pi-ai anthropic-state.ts). The rest
 * run one-shot:
 *
 * - utility requests sent through `completeSimple` without that store: session titles
 *   (utils/title-generator.ts, a random title session id) and the auto-thinking judge
 *   (pi-ai judgment/chat.ts, which reuses the session's provider session id);
 * - the compaction and branch summarizer, which does carry the store and session id: its
 *   context is exactly `{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], … }` (pi-agent-core
 *   compaction/compaction.ts, compaction/branch-summarization.ts);
 * - omp side requests (handoff document, `/btw`, ephemeral turns), by their session id.
 *
 * None of these carry tool results for the pooled agent's live run, so skipping the
 * pre-send drain leaves that run to the turn that owns it. A summarizer that arrives
 * while a live run waits for tool results (omp's mid-run compaction between provider
 * calls) must go one-shot: on the pool it would chain into that run and wait for tool
 * results only the continuation brings.
 */
export function isCursorOneShotRequest(
	context: Pick<Context, "systemPrompt">,
	options?: CursorRequestRoutingOptions,
): boolean {
	if (options?.providerSessionState === undefined) return true;
	const systemPrompt = context.systemPrompt;
	if (systemPrompt?.length === 1 && systemPrompt[0] === SUMMARIZATION_SYSTEM_PROMPT) return true;
	return options.sessionId?.includes(HOST_SIDE_REQUEST_SESSION_MARKER) === true;
}

/**
 * The conversation a pooled request belongs to: omp's provider session id for the agent
 * loop that sent it (AgentSession.sessionId = a /fresh id ?? --provider-session-id ??
 * the session file id, agent-session.ts #activeProviderSessionId). Advisors run their
 * own loops under their own ids (advisor/config.ts getOrCreateAdvisorProviderSessionId).
 */
export function getCursorConversationId(options?: CursorRequestRoutingOptions): string {
	return options?.sessionId ?? "";
}

/** How one provider request is served: a one-shot agent, or a pooled conversation agent. */
export type CursorRequestRoute =
	| { oneShot: true; conversationId: string; mainConversation: false }
	| { oneShot: false; conversationId: string; mainConversation: boolean };

interface CursorConversationTrackerState {
	/** The session's own conversation: its provider session id and provider state store. */
	mainId?: string;
	mainProviderState?: object;
	/** Set by before_agent_start: the next pooled request starts the session's prompt. */
	armed: boolean;
	/** Conversation ids already seen as another loop of this session (advisors). */
	otherIds: Set<string>;
}

const conversationTracker: CursorConversationTrackerState = { armed: false, otherIds: new Set() };

interface CursorConversationTrackingExtensionApi {
	on(event: "session_start", handler: (event: unknown, ctx: { sessionManager?: { getSessionId?(): string } }) => unknown): void;
	on(event: "before_agent_start", handler: () => unknown): void;
}

/**
 * Track which conversation of the session is its own. omp runs other agent loops beside
 * the main one that also carry a provider state store: advisors share the session's store
 * under their own provider session id (pi-coding-agent session/session-advisors.ts), and
 * auto-learn capture uses a store of its own (sdk.ts createAutoLearnCaptureRunner). Neither
 * emits extension events, so the main conversation is the one whose id is the session
 * id (AgentSession.sessionId falls back to sessionManager.getSessionId(),
 * agent-session.ts #activeProviderSessionId), or, after `/fresh` or with
 * `--provider-session-id`, the first pooled request after before_agent_start.
 */
export function registerCursorConversationTracking(pi: CursorConversationTrackingExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		conversationTracker.mainId = ctx.sessionManager?.getSessionId?.() ?? undefined;
		conversationTracker.armed = false;
		conversationTracker.otherIds.clear();
	});
	pi.on("before_agent_start", () => {
		conversationTracker.armed = true;
		return undefined;
	});
}

export function classifyCursorRequestRoute(
	context: Pick<Context, "systemPrompt">,
	options?: CursorRequestRoutingOptions,
): CursorRequestRoute {
	const conversationId = getCursorConversationId(options);
	if (isCursorOneShotRequest(context, options)) return { oneShot: true, conversationId, mainConversation: false };
	const tracker = conversationTracker;
	const providerState = options?.providerSessionState;
	// Another agent session's loop (auto-learn capture keeps its own store).
	if (tracker.mainProviderState && providerState !== tracker.mainProviderState) {
		return { oneShot: true, conversationId, mainConversation: false };
	}
	const claimsMain =
		tracker.mainId === undefined ||
		conversationId === tracker.mainId ||
		(tracker.armed && !tracker.otherIds.has(conversationId));
	if (claimsMain) {
		tracker.mainId = conversationId;
		tracker.mainProviderState = providerState;
		tracker.armed = false;
		return { oneShot: false, conversationId, mainConversation: true };
	}
	tracker.otherIds.add(conversationId);
	return { oneShot: false, conversationId, mainConversation: false };
}

export const __testUtils = {
	reset(): void {
		conversationTracker.mainId = undefined;
		conversationTracker.mainProviderState = undefined;
		conversationTracker.armed = false;
		conversationTracker.otherIds.clear();
	},
};
