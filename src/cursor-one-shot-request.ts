import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
// Host constant, not a copy: omp routes this import to its own in-process pi-agent-core
// (pi-coding-agent extensibility/plugins/legacy-pi-compat.ts PI_PACKAGE_NAMES), so the
// comparison below uses the exact string the summarizer sends.
import { SUMMARIZATION_SYSTEM_PROMPT } from "@oh-my-pi/pi-agent-core/compaction/utils";
import {
	armCursorSessionBindingClaim,
	currentCursorSessionBinding,
	cursorSessionSlot,
	cursorSessionSlotView,
	learnCursorProviderSessionState,
	type CursorRequestResolution,
} from "./cursor-session-binding.js";

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
	| {
			oneShot: false;
			conversationId: string;
			mainConversation: boolean;
			/** The main conversation this request took over (after `/fresh`), now unused. */
			replacedMainConversationId?: string;
		};

interface CursorConversationTrackerState {
	/** The session's own conversation: its provider session id and provider state store. */
	mainId?: string;
	mainProviderState?: object;
	/** A request took `mainId` since the last session_start. */
	claimed: boolean;
	/** Set by before_agent_start: the next pooled request starts the session's prompt. */
	armed: boolean;
	/** Conversation ids already seen as another loop of this session (advisors). */
	otherIds: Set<string>;
}

// Per session (see cursor-session-binding.ts).
const conversationTracker: CursorConversationTrackerState = cursorSessionSlotView(
	cursorSessionSlot<CursorConversationTrackerState>(() => ({ armed: false, claimed: false, otherIds: new Set() })),
);

interface CursorConversationTrackingExtensionApi {
	on(event: "session_start", handler: (event: unknown, ctx: { sessionManager?: { getSessionId?(): string } }) => unknown): void;
	on(event: "before_agent_start", handler: (event: { prompt?: string }) => unknown): void;
}

/**
 * omp's advisor loops always carry the `advise` tool (session/session-advisors.ts
 * `advisorLoopTools = [adviseTool, ...tools]`, advisor/advise-tool.ts `name = "advise"`);
 * the session's own loop never has it.
 */
const ADVISOR_TOOL_NAME = "advise";

/** True for a request of one of omp's advisor loops. */
export function isCursorAdvisorRequest(context: Pick<Context, "tools">): boolean {
	return context.tools?.some((tool) => tool.name === ADVISOR_TOOL_NAME) === true;
}

/**
 * Track which conversation of the session is its own. omp runs other agent loops beside
 * the main one that also carry a provider state store: advisors share the session's store
 * under their own provider session id (pi-coding-agent session/session-advisors.ts), and
 * auto-learn capture uses a store of its own (sdk.ts createAutoLearnCaptureRunner). Neither
 * emits extension events. Advisor requests are recognized by their `advise` tool and never
 * take the main conversation; of the rest, the main conversation is the one whose id is
 * the session id (AgentSession.sessionId falls back to sessionManager.getSessionId(),
 * agent-session.ts #activeProviderSessionId), or, after `/fresh` or with
 * `--provider-session-id`, the first pooled request after before_agent_start.
 */
export function registerCursorConversationTracking(pi: CursorConversationTrackingExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		conversationTracker.mainId = ctx.sessionManager?.getSessionId?.() ?? undefined;
		conversationTracker.claimed = false;
		conversationTracker.armed = false;
		conversationTracker.otherIds.clear();
	});
	pi.on("before_agent_start", (event) => {
		conversationTracker.armed = true;
		armCursorSessionBindingClaim(currentCursorSessionBinding(), event?.prompt);
		return undefined;
	});
}

export function classifyCursorRequestRoute(
	context: Pick<Context, "systemPrompt" | "tools">,
	options?: CursorRequestRoutingOptions,
	resolution?: CursorRequestResolution,
): CursorRequestRoute {
	const conversationId = getCursorConversationId(options);
	if (isCursorOneShotRequest(context, options)) return { oneShot: true, conversationId, mainConversation: false };
	// No session can be told for it, or it reached the root session only by falling back
	// while a `/tan` clone waits for its first request: it must not take a conversation.
	if (resolution?.via === "unknown" || (resolution?.via === "fallback" && resolution.contested)) {
		return { oneShot: true, conversationId, mainConversation: false };
	}
	const tracker = conversationTracker;
	const providerState = options?.providerSessionState;
	// Another agent session's loop (auto-learn capture keeps its own store).
	if (tracker.mainProviderState && providerState !== tracker.mainProviderState) {
		return { oneShot: true, conversationId, mainConversation: false };
	}
	// An advisor loop: pooled, but never the session's own conversation, even when the
	// main loop runs on another provider (the tracker then stays armed) or an advisor's
	// new id after `/fresh` arrives before the main loop's.
	if (isCursorAdvisorRequest(context)) {
		tracker.otherIds.add(conversationId);
		return { oneShot: false, conversationId, mainConversation: false };
	}
	const claimsMain =
		tracker.mainId === undefined ||
		conversationId === tracker.mainId ||
		(tracker.armed && !tracker.otherIds.has(conversationId));
	if (claimsMain) {
		const replacedMainConversationId = tracker.claimed && tracker.mainId !== conversationId ? tracker.mainId : undefined;
		tracker.mainId = conversationId;
		tracker.claimed = true;
		tracker.mainProviderState = providerState;
		tracker.armed = false;
		// Later calls of this session resolve to it by their store (advisors share it).
		learnCursorProviderSessionState(currentCursorSessionBinding(), providerState);
		return replacedMainConversationId === undefined
			? { oneShot: false, conversationId, mainConversation: true }
			: { oneShot: false, conversationId, mainConversation: true, replacedMainConversationId };
	}
	tracker.otherIds.add(conversationId);
	return { oneShot: false, conversationId, mainConversation: false };
}

export const __testUtils = {
	/** The current session's main conversation. */
	mainConversation: () => ({ id: conversationTracker.mainId, providerState: conversationTracker.mainProviderState }),
	reset(): void {
		conversationTracker.mainId = undefined;
		conversationTracker.mainProviderState = undefined;
		conversationTracker.claimed = false;
		conversationTracker.armed = false;
		conversationTracker.otherIds.clear();
	},
};
