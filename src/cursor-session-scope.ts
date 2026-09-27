import { resolve } from "node:path";
import type { ExtensionHandler, SessionStartEvent } from "@oh-my-pi/pi-coding-agent";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { cursorSessionSlot } from "./cursor-session-binding.js";

interface CursorSessionScopeExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";
export const MAX_CURSOR_SESSION_NAME_LENGTH = 100;

type CursorSessionScopeChangeHandler = (previousScopeKey: string) => Promise<void> | void;

// Per session (see cursor-session-binding.ts): a subagent's session_start must not move
// its parent's scope.
const scopeSlot = cursorSessionSlot(() => ({
	sessionCwd: process.cwd(),
	sessionFile: undefined as string | undefined,
	sessionId: undefined as string | undefined,
	sessionName: undefined as string | undefined,
	projectTrusted: false,
	sessionGeneration: 0,
}));

const scopeGenerations = new Map<string, number>([[ANONYMOUS_SESSION_SCOPE_KEY, 0]]);
const projectTrustResolutionCwds = new Set<string>();
let nextSessionGeneration = 1;
let scopeChangeHandler: CursorSessionScopeChangeHandler | undefined;

/**
 * Pi session file when known; used to scope reused Cursor SDK agents to one pi session.
 */
export function getCursorSessionFile(): string | undefined {
	const state = scopeSlot.get();
	return state.sessionFile;
}

/**
 * Stable scope key for session-agent pooling. Falls back to a process-local anonymous key
 * before the first session_start (tests and early startup).
 */
export function getCursorSessionScopeKey(): string {
	const state = scopeSlot.get();
	if (state.sessionFile) return state.sessionFile;
	if (state.sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${state.sessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

export function getCursorSessionScopeGeneration(scopeKey: string = getCursorSessionScopeKey()): number {
	return scopeGenerations.get(scopeKey) ?? 0;
}

/**
 * Pi session cwd when known; falls back to process.cwd() before session_start.
 * Updated on session_start only until pi threads cwd into streamSimple—mid-session cwd
 * changes without a new session_start event are not reflected here.
 */
export function getCursorSessionCwd(): string {
	const state = scopeSlot.get();
	return state.sessionCwd;
}

export function getCursorSessionProjectTrusted(): boolean {
	const state = scopeSlot.get();
	return state.projectTrusted;
}

export function getCursorSessionName(): string | undefined {
	const state = scopeSlot.get();
	return state.sessionName;
}

function normalizeCursorSessionName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	return truncateCursorDisplayLine(name, MAX_CURSOR_SESSION_NAME_LENGTH) || undefined;
}

function setCursorSessionScope(
	cwd: string,
	sessionFile: string | undefined,
	sessionId?: string,
	projectTrusted = false,
	sessionName?: string,
): void {
	const state = scopeSlot.get();
	state.sessionCwd = cwd;
	state.sessionFile = sessionFile;
	state.sessionId = sessionId;
	state.sessionName = normalizeCursorSessionName(sessionName);
	state.projectTrusted = projectTrusted;
	state.sessionGeneration = nextSessionGeneration;
	nextSessionGeneration += 1;
	scopeGenerations.set(getCursorSessionScopeKey(), state.sessionGeneration);
}

function recordProjectTrustResolution(cwd: string): void {
	projectTrustResolutionCwds.add(resolve(cwd));
}

// OMP has no per-project trust event or --approve flag (Pi 0.84 surface);
// --auto-approve is the closest analog and defaults to untrusted.
function isCliProjectTrustApproved(args = process.argv.slice(2)): boolean {
	return args.includes("--auto-approve");
}

function resetCursorSessionScope(): void {
	scopeSlot.reset();
	nextSessionGeneration = 1;
	scopeGenerations.clear();
	scopeGenerations.set(ANONYMOUS_SESSION_SCOPE_KEY, 0);
	projectTrustResolutionCwds.clear();
}

export function onCursorSessionScopeKeyChange(handler: CursorSessionScopeChangeHandler): void {
	scopeChangeHandler = handler;
}

export function registerCursorSessionScope(pi: CursorSessionScopeExtensionApi): void {
	pi.on("session_start", async (_event, ctx) => {
		const previousScopeKey = getCursorSessionScopeKey();
		setCursorSessionScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			ctx.sessionManager?.getSessionId?.() ?? undefined,
			isCliProjectTrustApproved(),
			ctx.sessionManager?.getSessionName?.() ?? undefined,
		);
		if (previousScopeKey !== getCursorSessionScopeKey()) {
			await scopeChangeHandler?.(previousScopeKey);
		}
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	set: setCursorSessionScope,
	recordProjectTrustResolution,
	isCliProjectTrustApproved,
	reset: resetCursorSessionScope,
};
