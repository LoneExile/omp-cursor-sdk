import type { McpServerConfig } from "@cursor/sdk";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import type {
	ExtensionAPI,
	ExtensionHandler,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolInfo,
	ToolResultEvent,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent";

export type CursorPiToolBridgeSnapshotApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools">;

export type CursorPiToolBridgeExtensionApi = CursorPiToolBridgeSnapshotApi & {
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
};

export interface CursorPiMcpInputSchema {
	type: "object";
	properties?: Record<string, object>;
	required?: string[];
	[key: string]: unknown;
}

export interface CursorPiBridgeToolDefinition {
	piToolName: string;
	mcpToolName: string;
	description: string;
	promptGuidelines?: ToolInfo["promptGuidelines"];
	inputSchema: CursorPiMcpInputSchema;
	sourceInfo: ToolInfo["sourceInfo"];
}

export interface CursorPiToolBridgeSnapshot {
	tools: CursorPiBridgeToolDefinition[];
	mcpToolNameToPiToolName: ReadonlyMap<string, string>;
	piToolNameToMcpToolName: ReadonlyMap<string, string>;
}

export interface CursorPiToolBridgeSnapshotOptions {
	exposeOverlappingBuiltins?: boolean;
}

export interface CursorPiBridgeToolRequest {
	runId: string;
	bridgeCallId: string;
	cursorMcpCallId?: string;
	piToolCallId: string;
	piToolName: string;
	mcpToolName: string;
	args: Record<string, unknown>;
}

export interface CursorPiToolBridgeRun {
	id: string;
	enabled: boolean;
	mcpServers?: Record<string, McpServerConfig>;
	snapshot: CursorPiToolBridgeSnapshot;
	takeQueuedToolRequests(): CursorPiBridgeToolRequest[];
	resolveToolResults(toolResults: readonly ToolResultMessage[]): Promise<void>;
	resolveToolResultsFromContext(context: Context): Promise<void>;
	hasPendingPiToolCallId(piToolCallId: string): boolean;
	/**
	 * True while omp may still be executing a bridged call: it is registered, unsettled, and omp has not
	 * yet produced its tool result. A call whose result omp already produced (completed, failed or aborted)
	 * stays pending for `hasPendingPiToolCallId` until the next provider request resolves it, but no longer
	 * counts here, so an abandoned one cannot hold its live run open.
	 */
	hasExecutingToolCalls(): boolean;
	/**
	 * Observe changes to the executing set (a call added, settled, cancelled, disposed, or its result produced).
	 * Listeners run synchronously on each change; a listener error never affects settlement.
	 * Returns an idempotent unsubscribe.
	 */
	onExecutingToolCallsChanged(listener: () => void): () => void;
	isBridgeMcpToolCall(toolCall: unknown): boolean;
	setOnToolRequest(handler?: (request: CursorPiBridgeToolRequest) => void): void;
	setDebugRecorder(recorder?: CursorSdkEventDebugRecorder): void;
	cancel(reason: string): void;
	dispose(): Promise<void>;
}

export interface CursorPiToolBridge {
	isEnabled(): boolean;
	getToolSurfaceSignature(): string;
	createRun(options?: CursorPiToolBridgeRunOptions): Promise<CursorPiToolBridgeRun>;
	disposeAll(reason?: string): Promise<void>;
}

export interface CursorPiToolBridgeRunOptions {
	onToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	debugRecorder?: CursorSdkEventDebugRecorder;
}
