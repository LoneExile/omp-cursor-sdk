import { spawnSync } from "node:child_process";
import {
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	type CursorPiToolBridgeDiagnosticEvent,
	serializeCursorPiToolBridgeDiagnostic,
} from "./cursor-pi-tool-bridge-diagnostics.js";
import {
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV,
	CURSOR_PI_TOOL_BRIDGE_ENV,
} from "./cursor-pi-tool-bridge-env.js";
import { cursorSessionSlot } from "./cursor-session-binding.js";
import { isCursorPiBridgeToolCallId, MCP_SERVER_NAME } from "./cursor-pi-tool-bridge-constants.js";
import { LOOPBACK_HOST, CursorPiToolBridgeRegistry } from "./cursor-pi-tool-bridge-server.js";
import type {
	CursorPiToolBridge,
	CursorPiToolBridgeExtensionApi,
	CursorPiToolBridgeSnapshotApi,
} from "./cursor-pi-tool-bridge-types.js";

export type {
	CursorPiBridgeToolDefinition,
	CursorPiBridgeToolRequest,
	CursorPiMcpInputSchema,
	CursorPiToolBridge,
	CursorPiToolBridgeExtensionApi,
	CursorPiToolBridgeRun,
	CursorPiToolBridgeRunOptions,
	CursorPiToolBridgeSnapshot,
	CursorPiToolBridgeSnapshotApi,
	CursorPiToolBridgeSnapshotOptions,
} from "./cursor-pi-tool-bridge-types.js";
export type { CursorPiToolBridgeDiagnosticEvent } from "./cursor-pi-tool-bridge-diagnostics.js";
export { resolveCursorPiToolBridgeDebugEnabled } from "./cursor-pi-tool-bridge-diagnostics.js";
export {
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV,
	CURSOR_PI_TOOL_BRIDGE_ENV,
	resolveCursorPiToolBridgeBuiltinsEnabled,
	resolveCursorPiToolBridgeCallTimeoutMs,
	resolveCursorPiToolBridgeEnabled,
} from "./cursor-pi-tool-bridge-env.js";
export {
	buildCursorPiToolBridgeSnapshot,
	buildCursorPiToolBridgeSurfaceSignature,
} from "./cursor-pi-tool-bridge-snapshot.js";

// Per session (see cursor-session-binding.ts): a subagent re-binds this factory in the
// same module, and its bridge must not replace, abort or dispose its parent's.
const bridgeSlot = cursorSessionSlot<{ bridge?: CursorPiToolBridgeRegistry }>(() => ({}));

const WINDOWS_BRIDGE_ABORT_ENV = "PI_CURSOR_BRIDGE_TOOL_CALL_ID";

function buildWindowsBridgeBashAbortCommand(command: string, marker: string): string {
	return `export ${WINDOWS_BRIDGE_ABORT_ENV}=${marker}; ${command}`;
}

function installWindowsBridgeBashAbortMarker(event: { toolCallId: string; toolName: string; input: unknown }): string | undefined {
	if (process.platform !== "win32" || event.toolName !== "bash") return undefined;
	if (typeof event.input !== "object" || event.input === null || !("command" in event.input)) return undefined;
	const input = event.input as { command?: unknown };
	if (typeof input.command !== "string" || input.command.length === 0) return undefined;
	const marker = event.toolCallId.replace(/[^A-Za-z0-9_.:-]/g, "_");
	input.command = buildWindowsBridgeBashAbortCommand(input.command, marker);
	return marker;
}

function killWindowsBridgeBashMarkerTree(marker: string | undefined): void {
	if (process.platform !== "win32" || !marker) return;
	const encodedMarker = Buffer.from(marker, "utf8").toString("base64");
	const script = `
$marker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMarker}'))
$needle = '${WINDOWS_BRIDGE_ABORT_ENV}=' + $marker
$seen = @{}
function Stop-Tree([int]$ProcessId) {
  if ($seen.ContainsKey($ProcessId)) { return }
  $seen[$ProcessId] = $true
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId } | ForEach-Object { Stop-Tree $_.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'bash.exe' OR Name = 'sh.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |
  ForEach-Object { Stop-Tree $_.ProcessId }
`;
	spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
		stdio: "ignore",
		timeout: 3_000,
		windowsHide: true,
	});
}

export function registerCursorPiToolBridge(pi: CursorPiToolBridgeExtensionApi): CursorPiToolBridge {
	// No cleanup of an earlier registration here. In one module instance a later factory
	// call is always another live session (a subagent re-binding the prepared factory,
	// sdk.ts preloadedPreparedExtensions); a reload imports a new module instance
	// (legacy-pi-compat.ts loadLegacyPiModule, fresh `?mtime` tag), and the replaced
	// session's own session_shutdown handler below disposes its bridge.
	// tool_call/tool_result handlers attach on the first run that exposes pi tools: omp's
	// speculative local-read execution is off whenever any extension handles either event
	// (pi-coding-agent speculation/host.ts hasLifecycleHandlers), so registering them at load
	// would turn it off for sessions that never use a Cursor model. omp has no unsubscribe.
	let toolHooksAttached = false;
	const attachToolHooks = (): void => {
		if (toolHooksAttached) return;
		toolHooksAttached = true;
		pi.on("tool_call", (event, ctx) => {
			if (!bridge.hasPendingPiToolCallId(event.toolCallId)) {
				return isCursorPiBridgeToolCallId(event.toolCallId)
					? { block: true, reason: "Cursor pi bridge tool call is no longer pending" }
					: undefined;
			}
			const windowsAbortMarker = installWindowsBridgeBashAbortMarker(event);
			const trackingStarted = bridge.abortTracker.track(event.toolCallId, {
				// OMP's ExtensionContext exposes abort() but no signal, so the
				// tracker cannot observe host-initiated aborts from the signal
				// alone; cancellation arrives via tool_result, session_shutdown,
				// or the turn_end handler below. A locally-owned AbortController
				// was tried and removed: it made the tracker's signal
				// self-referential (only our own abort could trip it) and
				// double-fired ctx.abort() on tracker-initiated aborts.
				abort: () => {
					ctx.abort();
					killWindowsBridgeBashMarkerTree(windowsAbortMarker);
				},
				cancelPending: (reason) => {
					bridge.cancelPendingPiToolCallId(event.toolCallId, reason);
				},
			});
			if (trackingStarted) return undefined;
			return { block: true, reason: "Cursor pi bridge tool execution was aborted before it started" };
		});
		pi.on("tool_result", (event) => {
			bridge.abortTracker.finish(event.toolCallId);
		});
	};
	const bridge = new CursorPiToolBridgeRegistry(pi, process.env, attachToolHooks);
	bridgeSlot.get().bridge = bridge;
	// Closest OMP analog to upstream's host-abort signal edge: any bridge
	// execution of this session still active when its turn ends is aborted.
	pi.on("turn_end", () => {
		bridge.abortTracker.abortAll("Cursor pi tool bridge turn ended");
	});
	pi.on("session_shutdown", async () => {
		const reason = "Cursor pi tool bridge session shutdown";
		bridge.abortTracker.abortAll(reason);
		await bridge.disposeAll(reason);
	});
	return bridge;
}

export function getRegisteredCursorPiToolBridge(): CursorPiToolBridge | undefined {
	return bridgeSlot.get().bridge;
}

export const __testUtils = {
	CURSOR_PI_TOOL_BRIDGE_ENV,
	CURSOR_PI_TOOL_BRIDGE_BUILTINS_ENV,
	CURSOR_PI_TOOL_BRIDGE_CALL_TIMEOUT_MS_ENV,
	CURSOR_PI_TOOL_BRIDGE_DEBUG_ENV,
	CURSOR_PI_TOOL_BRIDGE_DIAGNOSTIC_PREFIX,
	LOOPBACK_HOST,
	MCP_SERVER_NAME,
	createRegistry(
		pi: CursorPiToolBridgeSnapshotApi,
		env: Record<string, string | undefined> = process.env,
	) {
		return new CursorPiToolBridgeRegistry(pi, env);
	},
	getRegisteredBridgeForTests() {
		return bridgeSlot.get().bridge;
	},
	serializeDiagnosticForTests(event: CursorPiToolBridgeDiagnosticEvent) {
		return serializeCursorPiToolBridgeDiagnostic(event);
	},
	getActiveBridgeToolExecutionAbortCount() {
		return bridgeSlot.get().bridge?.abortTracker.getActiveCount() ?? 0;
	},
	buildWindowsBridgeBashAbortCommandForTests: buildWindowsBridgeBashAbortCommand,
	installWindowsBridgeBashAbortMarkerForTests: installWindowsBridgeBashAbortMarker,
	emitBridgeToolExecutionProcessAbortSignalForTests(signal: NodeJS.Signals) {
		bridgeSlot.get().bridge?.abortTracker.emitProcessAbortSignalForTests(signal);
	},
	resetRegisteredBridgeForTests() {
		const bridge = bridgeSlot.get().bridge;
		bridge?.abortTracker.abortAll("Cursor pi tool bridge test reset");
		bridgeSlot.reset();
		return bridge?.disposeAll("Cursor pi tool bridge test reset") ?? Promise.resolve();
	},
};
