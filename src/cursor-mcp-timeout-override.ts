const CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS = 3_600_000;
const DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS = 10_000;
const MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS = 1_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const CURSOR_MCP_TOOL_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_MS";
const CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_TOOL_TIMEOUT_SECONDS";
const CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV = "PI_CURSOR_MCP_CONNECT_TIMEOUT_MS";
const CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV = "PI_CURSOR_MCP_CONNECT_TIMEOUT_SECONDS";

interface CursorMcpToolTimeoutOverrideOptions {
	timeoutMs?: number;
	connectTimeoutMs?: number;
	env?: Record<string, string | undefined>;
}

interface CursorMcpToolTimeoutOverrideState {
	installed: boolean;
	timeoutMs: number;
	connectTimeoutMs: number;
	sdkDefaultTimeoutMs: number;
}

type GlobalSetTimeout = typeof globalThis.setTimeout;
type SetTimeoutHandler = Parameters<GlobalSetTimeout>[0];
type SetTimeoutDelay = Parameters<GlobalSetTimeout>[1];

let originalSetTimeout: GlobalSetTimeout | undefined;
let installedToolTimeoutMs = DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
let installedConnectTimeoutMs = DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;

function parsePositiveNumber(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOverrideTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
	return Math.min(Math.max(Math.trunc(timeoutMs), CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS), MAX_NODE_TIMER_DELAY_MS);
}

export function resolveCursorMcpToolTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const explicitMs = parsePositiveNumber(env[CURSOR_MCP_TOOL_TIMEOUT_MS_ENV]);
	if (explicitMs !== undefined) return normalizeOverrideTimeoutMs(explicitMs);

	const explicitSeconds = parsePositiveNumber(env[CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV]);
	if (explicitSeconds !== undefined) return normalizeOverrideTimeoutMs(explicitSeconds * 1000);

	return DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
}

function normalizeConnectTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
	return Math.min(
		Math.max(Math.trunc(timeoutMs), MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS),
		CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	);
}

export function resolveCursorMcpConnectTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const explicitMs = parsePositiveNumber(env[CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV]);
	if (explicitMs !== undefined) return normalizeConnectTimeoutMs(explicitMs);

	const explicitSeconds = parsePositiveNumber(env[CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV]);
	if (explicitSeconds !== undefined) return normalizeConnectTimeoutMs(explicitSeconds * 1000);

	return DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
}

// The SDK minifies its class names and splits its builds into numbered chunks, so a timeout's
// purpose is classified from frames by method name and SDK path, never by a class name or a
// chunk file name. A stack is the protocol timer, `_setupTimeout`, armed by the protocol base
// class's `request`; the purpose is the protocol client method that called `request`, which is
// the frame right after it. Bun (JavaScriptCore) prints bare method names, V8 prefixes the
// minified class name, and the path is the SDK build the runtime loaded (`dist/bundled/index.js`
// under Bun, a numbered chunk of `dist/esm` or `dist/cjs` under Node):
//   Bun/JSC  at request (…/node_modules/@cursor/sdk/dist/<build>/<file>.js:L:C)
//            at async listTools (…/node_modules/@cursor/sdk/dist/<build>/<file>.js:L:C)
//   V8       at <Class>.request (file:///…/@cursor/sdk/dist/<build>/<file>.js:L:C)
//            at async <Class>.listTools (file:///…/@cursor/sdk/dist/<build>/<file>.js:L:C)
// Requiring that adjacency keeps an unknown request (`listPrompts`, `ping`, …) on the SDK
// default even when a `connect`, `listTools` or `callTool` frame sits further up the
// stack, and a `connect` resumed inside a `callTool` keeps the connect timeout. A tool call
// is the `callTool` frame of the protocol client: the agent-side wrapper reaches it through a
// plain `sendToolCall`, which only calls `client.callTool` unless the SDK itself sets a tool-call
// request option or the output-schema passthrough (nothing in the package does;
// `test/cursor-mcp-timeout-sdk-stack.test.ts` fails if that changes).
const CURSOR_SDK_PATH_PATTERN = String.raw`(?:node_modules[/\\]@cursor[/\\]sdk|@cursor/sdk/dist)`;

function cursorSdkFramePattern(methods: string): string {
	return String.raw`^[ \t]*at (?:async )?(?:[\w$]+\.)*(?:${methods}) \(.*${CURSOR_SDK_PATH_PATTERN}[^\n]*`;
}

const CURSOR_SDK_MCP_TIMEOUT_FRAME_REGEX = new RegExp(cursorSdkFramePattern("_setupTimeout"), "m");
const CURSOR_SDK_MCP_TOOL_REQUEST_REGEX = new RegExp(
	`${cursorSdkFramePattern("request")}\\n${cursorSdkFramePattern("callTool")}`,
	"m",
);
const CURSOR_SDK_MCP_CONNECT_REQUEST_REGEX = new RegExp(
	`${cursorSdkFramePattern("request")}\\n${cursorSdkFramePattern("connect|listTools")}`,
	"m",
);

function isCursorSdkMcpTimeoutStack(stack: string | undefined, purposeRegex: RegExp): boolean {
	if (!stack) return false;
	return CURSOR_SDK_MCP_TIMEOUT_FRAME_REGEX.test(stack) && purposeRegex.test(stack);
}

export function isCursorSdkMcpToolTimeoutStack(stack: string | undefined): boolean {
	return isCursorSdkMcpTimeoutStack(stack, CURSOR_SDK_MCP_TOOL_REQUEST_REGEX);
}

export function isCursorSdkMcpConnectTimeoutStack(stack: string | undefined): boolean {
	return isCursorSdkMcpTimeoutStack(stack, CURSOR_SDK_MCP_CONNECT_REQUEST_REGEX);
}

function isCursorSdkDefaultMcpTimeout(delay: SetTimeoutDelay): boolean {
	return typeof delay === "number" && delay === CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS;
}

function patchedSetTimeout(
	handler: SetTimeoutHandler,
	delay?: SetTimeoutDelay,
	...args: unknown[]
): ReturnType<GlobalSetTimeout> {
	const delegate = originalSetTimeout;
	if (!delegate) throw new Error("Cursor MCP timeout override installed without original setTimeout");

	let nextDelay = delay;
	if (isCursorSdkDefaultMcpTimeout(delay)) {
		const stack = new Error().stack;
		if (isCursorSdkMcpToolTimeoutStack(stack)) {
			nextDelay = installedToolTimeoutMs;
		} else if (isCursorSdkMcpConnectTimeoutStack(stack)) {
			nextDelay = installedConnectTimeoutMs;
		}
	}

	return Reflect.apply(delegate, globalThis, [handler, nextDelay, ...args]) as ReturnType<GlobalSetTimeout>;
}

export function installCursorMcpToolTimeoutOverride(
	options: CursorMcpToolTimeoutOverrideOptions = {},
): CursorMcpToolTimeoutOverrideState {
	installedToolTimeoutMs = normalizeOverrideTimeoutMs(
		options.timeoutMs ?? resolveCursorMcpToolTimeoutMs(options.env),
	);
	installedConnectTimeoutMs = normalizeConnectTimeoutMs(
		options.connectTimeoutMs ?? resolveCursorMcpConnectTimeoutMs(options.env),
	);

	if (!originalSetTimeout) {
		originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = patchedSetTimeout as GlobalSetTimeout;
	}

	return {
		installed: true,
		timeoutMs: installedToolTimeoutMs,
		connectTimeoutMs: installedConnectTimeoutMs,
		sdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	};
}

export function restoreCursorMcpToolTimeoutOverride(): void {
	if (originalSetTimeout) {
		globalThis.setTimeout = originalSetTimeout;
		originalSetTimeout = undefined;
	}
	installedToolTimeoutMs = DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS;
	installedConnectTimeoutMs = DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS;
}

export const cursorMcpToolTimeoutOverrideDefaults = {
	cursorSdkDefaultTimeoutMs: CURSOR_SDK_MCP_DEFAULT_TIMEOUT_MS,
	defaultOverrideTimeoutMs: DEFAULT_CURSOR_MCP_TOOL_TIMEOUT_MS,
	defaultConnectTimeoutMs: DEFAULT_CURSOR_MCP_CONNECT_TIMEOUT_MS,
	minConnectTimeoutMs: MIN_CURSOR_MCP_CONNECT_TIMEOUT_MS,
	maxNodeTimerDelayMs: MAX_NODE_TIMER_DELAY_MS,
	timeoutMsEnv: CURSOR_MCP_TOOL_TIMEOUT_MS_ENV,
	timeoutSecondsEnv: CURSOR_MCP_TOOL_TIMEOUT_SECONDS_ENV,
	connectTimeoutMsEnv: CURSOR_MCP_CONNECT_TIMEOUT_MS_ENV,
	connectTimeoutSecondsEnv: CURSOR_MCP_CONNECT_TIMEOUT_SECONDS_ENV,
} as const;
