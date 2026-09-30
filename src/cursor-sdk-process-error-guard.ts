import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { classifyCursorConnectError, isCursorSdkAbortConnectError, isCursorSdkConnectionStalledError } from "./cursor-provider-errors.js";
import { cursorSessionSlot, cursorSessionSlotView } from "./cursor-session-binding.js";

interface CursorSdkProcessErrorGuardToken {
	suppressAbortErrors: boolean;
	onLocalTransportClosedPipe?: () => void;
}

interface CursorSdkSessionProcessErrorGuardToken {}

export interface CursorSdkProcessErrorGuard {
	suppressAbortErrors(): void;
	containLocalTransportClosedPipe(onClosedPipe: () => void): void;
	dispose(): void;
}

export interface CursorSdkSessionProcessErrorGuard {
	dispose(): void;
}

type GenericProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

// Cursor SDK controlled-exec tasks can reject after their originating provider turn
// has ended. The exact closed-writable failure is therefore session-scoped; existing
// ConnectRPC suppression remains scoped to active provider turns.
const activeProviderTurns = new Set<CursorSdkProcessErrorGuardToken>();
const activeSessions = new Set<CursorSdkSessionProcessErrorGuardToken>();
// Per session (see cursor-session-binding.ts): a subagent's session_shutdown must not
// remove its parent's guard.
const lifecycleGuards = cursorSessionSlotView(
	cursorSessionSlot<{ active?: CursorSdkSessionProcessErrorGuard }>(() => ({})),
);
let originalProcessEmit: GenericProcessEmit | undefined;
let cursorProcessEmit: GenericProcessEmit | undefined;
let unregisterHostRejectionInterceptor: (() => void) | undefined;

function hasActiveGuard(): boolean {
	return activeProviderTurns.size > 0 || activeSessions.size > 0;
}

function hasActiveAbortSuppression(): boolean {
	for (const turn of activeProviderTurns) {
		if (turn.suppressAbortErrors) return true;
	}
	return false;
}

function isCursorProvenance(source: string): boolean {
	return source === "cursor-sdk-stack" || source === "cursor-extension-connect-stack" || source === "cursor-backend-details";
}

const CURSOR_SDK_DIST_STACK_FRAME = /(?:^|[\\/])node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/;

function isCursorSdkWriteIterableClosedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WriteIterableClosedError" &&
		error.message === "WritableIterable is closed" &&
		CURSOR_SDK_DIST_STACK_FRAME.test(error.stack ?? "")
	);
}

// The Cursor SDK aborts an in-flight controlled-exec turn via its internal
// `AbortController.abort()` (user interrupt or stall-detector cancellation),
// which surfaces as a raw `DOMException [AbortError]` rather than a
// `ConnectError`. `classifyCursorConnectError` returns undefined for it, so it
// otherwise falls through the emit patch and terminates the process. A
// DOMException is not `instanceof Error`, so match structurally on the
// `AbortError` name plus the same `@cursor/sdk/dist` stack provenance the
// WriteIterableClosedError recognizer uses, keeping unrelated AbortErrors fatal.
function isCursorSdkAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, stack } = error as { name?: unknown; stack?: unknown };
	return (
		name === "AbortError" &&
		typeof stack === "string" &&
		CURSOR_SDK_DIST_STACK_FRAME.test(stack)
	);
}

// The exact observed incident: the Cursor SDK 1.0.23 local shell executor writes a
// spawned child's stdin without a stream 'error' listener, so a child exiting while
// a write is in flight surfaces a raw `write EPIPE` uncaught exception whose stack
// is exactly the single async pipe-write completion frame. Pi's own piped-stdout or
// dead-terminal EPIPE normally surfaces through the synchronous write-dispatch path
// with multiple frames (afterWriteDispatched/Socket._writeGeneric) and must stay
// fatal per Unix convention, so anything beyond this one-frame contract is rejected.
const OBSERVED_CLOSED_PIPE_STACK_FRAME =
	/^\s+at WriteWrap\.onWriteComplete \[as oncomplete\] \(node:internal\/stream_base_commons:\d+:\d+\)$/;

function isObservedLocalTransportClosedPipeWriteError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name !== "Error") return false;
	const { code, syscall } = error as NodeJS.ErrnoException;
	if (code !== "EPIPE" || syscall !== "write" || !error.message.startsWith("write EPIPE")) return false;
	const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
	return frames.length === 1 && OBSERVED_CLOSED_PIPE_STACK_FRAME.test(frames[0] ?? "");
}

// The Cursor SDK 1.0.32 local shell tool reaches its executor through an exec replay cache
// (`Ml1` in dist/bundled/index.js) whose per-exec stream (`mD0`) starts draining the shell stream
// from its constructor without observing the promise, and ends its readers normally when the
// stream throws. A shell that fails to start therefore surfaces only as an unhandled rejection
// whose stack is the SDK's spawn call site, in one of two shapes:
// - the child_process spawn error. Bun reports it in two forms: an asynchronous 'error' event
//   with syscall `spawn <file>` (a missing working directory is ENOENT on the spawned binary:
//   `posix_spawn '/bin/zsh'`), and an error thrown by spawn() itself with syscall `posix_spawn`
//   (a working directory that is a regular file is ENOTDIR; an argument list over the OS limit
//   is E2BIG);
// - with local sandboxing, the SDK spawns the shell through its sandbox helper (`qM8`), which
//   rethrows a synchronous spawn error as a plain Error without errno fields, `Failed to spawn
//   sandboxed process: <the original error>`.
const SANDBOXED_SPAWN_FAILURE_MESSAGE_PREFIX = "Failed to spawn sandboxed process: ";

function isCursorSdkSpawnFailure(error: unknown): error is NodeJS.ErrnoException {
	if (!(error instanceof Error) || !CURSOR_SDK_DIST_STACK_FRAME.test(error.stack ?? "")) return false;
	if (error.message.startsWith(SANDBOXED_SPAWN_FAILURE_MESSAGE_PREFIX)) return true;
	const { code, syscall } = error as NodeJS.ErrnoException;
	return typeof code === "string" && typeof syscall === "string" && /^(?:posix_)?spawn(?: |$)/.test(syscall);
}

// Contained only while a provider turn that declared a local transport is active;
// each contained turn invalidates its own session-agent scope for recreation.
function containLocalTransportClosedPipeError(): boolean {
	let contained = false;
	for (const turn of [...activeProviderTurns]) {
		if (!turn.onLocalTransportClosedPipe) continue;
		contained = true;
		try {
			turn.onLocalTransportClosedPipe();
		} catch {
			// stale-agent invalidation must not throw inside process error handling
		}
	}
	return contained;
}

function shouldSuppressProcessError(event: string | symbol, args: readonly unknown[]): boolean {
	if (event !== "uncaughtException" && event !== "unhandledRejection") return false;
	const error = args[0];
	if (isObservedLocalTransportClosedPipeWriteError(error)) {
		return containLocalTransportClosedPipeError();
	}
	if (isCursorSdkWriteIterableClosedError(error)) return activeSessions.size > 0;
	// SDK stall timers and inter-turn teardown aborts never call suppressAbortErrors();
	// any active provider turn or session is enough — stack provenance already gates SDK-only AbortErrors.
	if (isCursorSdkAbortError(error)) return hasActiveGuard();
	if (isCursorSdkSpawnFailure(error)) return hasActiveGuard();
	// RetriableError "Connection stalled" / "Connection stalled repeatedly" is not a ConnectError; suppress during active turns only.
	if (isCursorSdkConnectionStalledError(error)) return activeProviderTurns.size > 0;
	const classification = classifyCursorConnectError(error);
	if (!classification) return false;
	if (classification.kind === "abort") return hasActiveAbortSuppression();
	if (activeProviderTurns.size === 0) return false;
	if (classification.kind === "network") return isCursorProvenance(classification.source) || classification.source === "connect-node-stack";
	return isCursorProvenance(classification.source);
}

function installProcessEmitPatch(): void {
	if (cursorProcessEmit) {
		if (process.emit === cursorProcessEmit) return;
		if (process.emit !== originalProcessEmit) return;
		cursorProcessEmit = undefined;
		originalProcessEmit = undefined;
	}
	const forwardEmit = process.emit as GenericProcessEmit;
	originalProcessEmit = forwardEmit;
	cursorProcessEmit = function patchedCursorSdkProcessErrorEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
		if (shouldSuppressProcessError(event, args)) return true;
		return forwardEmit.call(this, event, ...args);
	};
	process.emit = cursorProcessEmit as typeof process.emit;
}

function reportContainedCursorSdkSpawnFailure(error: NodeJS.ErrnoException): void {
	logger.warn("Cursor SDK shell failed to start; contained its unhandled rejection", {
		error: error.message,
		code: error.code,
		syscall: error.syscall,
		path: error.path,
		...(error.code === "ENOENT"
			? { hint: "one possible cause: the working directory does not exist (Bun reports that as ENOENT on the spawned binary)" }
			: {}),
	});
}

// omp's postmortem owns the process `unhandledRejection` listener and exits on any rejection no
// interceptor claims. Bun calls process error listeners directly instead of through
// `process.emit`, so under omp the emit patch never sees a rejection; this interceptor is what
// keeps the host alive.
function interceptHostUnhandledRejection(reason: unknown): boolean {
	if (!shouldSuppressProcessError("unhandledRejection", [reason])) return false;
	if (isCursorSdkSpawnFailure(reason)) reportContainedCursorSdkSpawnFailure(reason);
	return true;
}

function installHostRejectionInterceptor(): void {
	if (unregisterHostRejectionInterceptor) return;
	unregisterHostRejectionInterceptor = postmortem.interceptUnhandledRejections(interceptHostUnhandledRejection);
}

function uninstallHostRejectionInterceptorIfIdle(): void {
	if (hasActiveGuard() || !unregisterHostRejectionInterceptor) return;
	unregisterHostRejectionInterceptor();
	unregisterHostRejectionInterceptor = undefined;
}

function uninstallProcessHooksIfIdle(): void {
	if (hasActiveGuard()) return;
	uninstallHostRejectionInterceptorIfIdle();
	if (!originalProcessEmit || !cursorProcessEmit || process.emit !== cursorProcessEmit) return;
	process.emit = originalProcessEmit as typeof process.emit;
	originalProcessEmit = undefined;
	cursorProcessEmit = undefined;
}

function installProcessHooks(): void {
	installProcessEmitPatch();
	installHostRejectionInterceptor();
}

export const __testUtils = {
	activeProviderTurnCount: (): number => activeProviderTurns.size,
	activeSessionCount: (): number => activeSessions.size,
	resetLifecycleSessionGuard(): void {
		lifecycleGuards.active?.dispose();
		lifecycleGuards.active = undefined;
	},
};

export { isCursorSdkAbortConnectError };

export function installCursorSdkProcessErrorGuard(): CursorSdkProcessErrorGuard {
	const token: CursorSdkProcessErrorGuardToken = { suppressAbortErrors: false };
	activeProviderTurns.add(token);
	installProcessHooks();
	let disposed = false;
	return {
		suppressAbortErrors(): void {
			if (disposed) return;
			token.suppressAbortErrors = true;
		},
		containLocalTransportClosedPipe(onClosedPipe: () => void): void {
			if (disposed) return;
			token.onLocalTransportClosedPipe = onClosedPipe;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeProviderTurns.delete(token);
			uninstallProcessHooksIfIdle();
		},
	};
}

export function installCursorSdkSessionProcessErrorGuard(): CursorSdkSessionProcessErrorGuard {
	const token: CursorSdkSessionProcessErrorGuardToken = {};
	activeSessions.add(token);
	installProcessHooks();
	let disposed = false;
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			activeSessions.delete(token);
			uninstallProcessHooksIfIdle();
		},
	};
}

export function registerCursorSdkSessionProcessErrorGuard(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("session_start", () => {
		lifecycleGuards.active?.dispose();
		lifecycleGuards.active = installCursorSdkSessionProcessErrorGuard();
	});
	pi.on("session_shutdown", () => {
		lifecycleGuards.active?.dispose();
		lifecycleGuards.active = undefined;
	});
}
