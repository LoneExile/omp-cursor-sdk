import type { ExtensionAPI, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { isCursorLocalAgentId } from "./cursor-session-agent-resume.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";
import { cursorSessionSlot, cursorSessionSlotView } from "./cursor-session-binding.js";
import { asRecord } from "./cursor-record-utils.js";

export const CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE = "cursor-sdk-agent-lineage";

const LINEAGE_ENTRY_VERSION = 1;

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !value) return false;
	const timestamp = Date.parse(value);
	return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

export interface CursorSessionAgentLineageEntryData {
	version: 1;
	runtime: "local";
	agentId: string;
	sessionId: string;
	sessionFile?: string;
	scopeKey: string;
	cwd: string;
	timestamp: string;
}

interface CursorSessionAgentLineageState {
	appendEntry?: ExtensionAPI["appendEntry"];
	sessionId?: string;
	sessionFile?: string;
	scopeKey?: string;
	cwd?: string;
	recordedAgentIds: Set<string>;
}

// Per session (see cursor-session-binding.ts): lineage entries go to the session whose
// provider call sent the agent.
const state: CursorSessionAgentLineageState = cursorSessionSlotView(
	cursorSessionSlot<CursorSessionAgentLineageState>(() => ({ recordedAgentIds: new Set() })),
);

export function parseCursorSessionAgentLineageEntryData(value: unknown): CursorSessionAgentLineageEntryData | undefined {
	const record = asRecord(value);
	if (
		record?.version !== LINEAGE_ENTRY_VERSION ||
		record.runtime !== "local" ||
		!isCursorLocalAgentId(record.agentId) ||
		typeof record.sessionId !== "string" ||
		!record.sessionId ||
		typeof record.scopeKey !== "string" ||
		!record.scopeKey ||
		typeof record.cwd !== "string" ||
		!record.cwd ||
		!isIsoTimestamp(record.timestamp)
	) {
		return undefined;
	}
	if (record.sessionFile !== undefined && (typeof record.sessionFile !== "string" || !record.sessionFile)) return undefined;
	return {
		version: LINEAGE_ENTRY_VERSION,
		runtime: "local",
		agentId: record.agentId,
		sessionId: record.sessionId,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		scopeKey: record.scopeKey,
		cwd: record.cwd,
		timestamp: record.timestamp,
	};
}

function readRecordedAgentIds(entries: readonly SessionEntry[], sessionId: string): Set<string> {
	return new Set(
		entries.flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE) return [];
			const data = parseCursorSessionAgentLineageEntryData(entry.data);
			return data?.sessionId === sessionId ? [data.agentId] : [];
		}),
	);
}

/** Best-effort forensic lineage at the local Agent.send() boundary. Independent of resume. */
export function recordCursorSessionAgentLineage(agentId: string): void {
	const { appendEntry, sessionId, sessionFile, scopeKey, cwd } = state;
	if (!appendEntry || !sessionId || !scopeKey || !cwd) return;
	if (!isCursorLocalAgentId(agentId) || state.recordedAgentIds.has(agentId)) return;
	const data: CursorSessionAgentLineageEntryData = {
		version: LINEAGE_ENTRY_VERSION,
		runtime: "local",
		agentId,
		sessionId,
		...(sessionFile ? { sessionFile } : {}),
		scopeKey,
		cwd,
		timestamp: new Date().toISOString(),
	};
	try {
		appendEntry<CursorSessionAgentLineageEntryData>(CURSOR_SESSION_AGENT_LINEAGE_ENTRY_TYPE, data);
		state.recordedAgentIds.add(agentId);
	} catch {
		// Lineage is forensic metadata; a failed stock pi append must not affect the session.
	}
}

interface CursorSessionAgentLineageExtensionApi {
	appendEntry: ExtensionAPI["appendEntry"];
	on: ExtensionAPI["on"];
}

export function registerCursorSessionAgentLineage(pi: CursorSessionAgentLineageExtensionApi): void {
	pi.on("session_start", (_event, ctx) => {
		state.appendEntry = pi.appendEntry;
		state.sessionId = ctx.sessionManager.getSessionId();
		state.sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		state.scopeKey = getCursorSessionScopeKey();
		state.cwd = ctx.cwd;
		state.recordedAgentIds = readRecordedAgentIds(ctx.sessionManager.getEntries(), state.sessionId);
	});
	pi.on("session_shutdown", () => {
		state.appendEntry = undefined;
		state.sessionId = undefined;
		state.sessionFile = undefined;
		state.scopeKey = undefined;
		state.cwd = undefined;
		state.recordedAgentIds = new Set();
	});
}

function resetStateForTests(): void {
	state.appendEntry = undefined;
	state.sessionId = undefined;
	state.sessionFile = undefined;
	state.scopeKey = undefined;
	state.cwd = undefined;
	state.recordedAgentIds = new Set();
}

export const __testUtils = {
	reset: resetStateForTests,
};
