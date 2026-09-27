import type { CursorSdkModule } from "./cursor-sdk-runtime.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
import { asRecord } from "./cursor-record-utils.js";
import { cursorSessionSlot, cursorSessionSlotView } from "./cursor-session-binding.js";

export const CURSOR_HTTP1_ENTRY_TYPE = "cursor-http1-state";

export interface CursorHttp1EntryData {
	enabled: boolean;
}

type CursorHttp1Sdk = {
	Cursor: Pick<CursorSdkModule["Cursor"], "configure">;
};

interface CursorHttp1SessionState {
	sessionCursorHttp1Enabled: boolean | undefined;
	globalPreferenceAuthoritative: boolean;
}

// Per session (see cursor-session-binding.ts). The SDK transport setting itself is
// process-wide and re-applied by every local turn (configureCursorSdkHttp1).
const sessionState = cursorSessionSlotView(cursorSessionSlot<CursorHttp1SessionState>(() => ({ sessionCursorHttp1Enabled: undefined, globalPreferenceAuthoritative: false })));
let configuredCursor: CursorHttp1Sdk["Cursor"] | undefined;

export function isCursorHttp1EntryData(value: unknown): value is CursorHttp1EntryData {
	return typeof asRecord(value)?.enabled === "boolean";
}

export function getStoredCursorHttp1Enabled(): boolean | undefined {
	return sessionState.sessionCursorHttp1Enabled;
}

export function setStoredCursorHttp1Enabled(enabled: boolean | undefined): void {
	sessionState.sessionCursorHttp1Enabled = enabled;
}

export function getResolvedSessionCursorHttp1Enabled(): boolean | undefined {
	return sessionState.globalPreferenceAuthoritative ? undefined : sessionState.sessionCursorHttp1Enabled;
}

export function setCursorHttp1GlobalPreferenceAuthoritative(authoritative: boolean): void {
	sessionState.globalPreferenceAuthoritative = authoritative;
}

export function clearCursorSdkHttp1(): void {
	if (configuredCursor === undefined) return;
	configuredCursor.configure({ local: { useHttp1ForAgent: null } });
	configuredCursor = undefined;
}

export function configureCursorSdkHttp1(
	sdk: CursorHttp1Sdk,
	setting: CursorResolvedSetting<boolean>,
): boolean | undefined {
	if (setting.source !== "builtin") {
		sdk.Cursor.configure({ local: { useHttp1ForAgent: setting.value } });
		configuredCursor = sdk.Cursor;
		return setting.value;
	}
	if (configuredCursor === sdk.Cursor) clearCursorSdkHttp1();
	else configuredCursor = undefined;
	return undefined;
}

export const __testUtils = {
	reset(): void {
		sessionState.sessionCursorHttp1Enabled = undefined;
		sessionState.globalPreferenceAuthoritative = false;
		configuredCursor = undefined;
	},
};
