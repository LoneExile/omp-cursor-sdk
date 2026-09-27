import type { CursorPiToolDisplay } from "./cursor-transcript-utils.js";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";
import { cursorSessionCollection, cursorSessionSlot, cursorSessionSlotView } from "./cursor-session-binding.js";

export interface CursorNativeToolDisplayItem extends CursorPiToolDisplay {
	id: string;
	terminate?: boolean;
}

export const NATIVE_CURSOR_TOOL_DISPLAY_ENV = "PI_CURSOR_NATIVE_TOOL_DISPLAY";
export const NATIVE_CURSOR_TOOL_REGISTRATION_ENV = "PI_CURSOR_REGISTER_NATIVE_TOOLS";

// Per session (see cursor-session-binding.ts): replay tools are registered on each
// session's own ExtensionAPI, so a subagent registers its own and never relies on its
// parent's registration.
export const registeredNativeToolNames = cursorSessionCollection(() => new Set<string>());
export const skippedNativeToolNames = cursorSessionCollection(() => new Set<string>());
export const nativeToolResults = new Map<string, CursorNativeToolDisplayItem>();

const displayState = cursorSessionSlotView(
	cursorSessionSlot(() => ({ runtimeRequested: false, registrationStarted: false })),
);

/** Latch per session: set before the first await of the replay-tool registration. */
export function claimCursorNativeToolRegistration(): boolean {
	if (displayState.registrationStarted) return false;
	displayState.registrationStarted = true;
	return true;
}

export function readBooleanEnv(name: string, env: Record<string, string | undefined> = process.env): boolean | undefined {
	return parseOptionalEnvBoolean(env[name]);
}

export function isCursorNativeToolDisplayRequested(mode?: string): boolean {
	const override = readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV);
	if (override !== undefined) return override;
	if (mode) return mode === "tui" || mode === "json" || mode === "rpc";
	return process.stdout.isTTY === true;
}

export function isCursorNativeToolRegistrationRequested(mode?: string): boolean {
	return mode !== "print" && readBooleanEnv(NATIVE_CURSOR_TOOL_REGISTRATION_ENV) !== false && isCursorNativeToolDisplayRequested(mode);
}

export function setCursorNativeToolDisplayRuntimeRequested(requested: boolean): void {
	displayState.runtimeRequested = requested;
}

export function isCursorNativeToolDisplayEnabled(): boolean {
	return registeredNativeToolNames.size > 0;
}

export function isCursorNativeToolDisplayRuntimeEnabled(): boolean {
	return displayState.runtimeRequested && readBooleanEnv(NATIVE_CURSOR_TOOL_DISPLAY_ENV) !== false && registeredNativeToolNames.size > 0;
}

export function canRenderCursorToolNatively(toolName: string): boolean {
	return registeredNativeToolNames.has(toolName);
}

export function isRegisteredCursorNativeToolName(toolName: string): boolean {
	return registeredNativeToolNames.has(toolName);
}

export function recordCursorNativeToolDisplay(item: CursorNativeToolDisplayItem): boolean {
	if (!canRenderCursorToolNatively(item.toolName)) return false;
	nativeToolResults.set(item.id, item);
	return true;
}

export function deleteCursorNativeToolDisplay(id: string): void {
	nativeToolResults.delete(id);
}

export function consumeCursorNativeToolDisplay(id: string): CursorNativeToolDisplayItem | undefined {
	const item = nativeToolResults.get(id);
	if (item) nativeToolResults.delete(id);
	return item;
}

export function isCursorReplayToolCallId(toolCallId: string): boolean {
	return toolCallId.startsWith("cursor-replay-");
}

export function isCursorFileMutationToolName(toolName: string): toolName is "edit" | "write" {
	return toolName === "edit" || toolName === "write";
}

export const __testUtils = {
	nativeToolResultCount: () => nativeToolResults.size,
	registerNativeToolNameForTests(toolName: string): void {
		displayState.runtimeRequested = true;
		registeredNativeToolNames.add(toolName);
	},
	reset(): void {
		displayState.runtimeRequested = false;
		displayState.registrationStarted = false;
		registeredNativeToolNames.clear();
		skippedNativeToolNames.clear();
		nativeToolResults.clear();
	},
};
