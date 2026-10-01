import { accessSync, constants, existsSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { classifyCursorConnectError, isCursorSdkAbortConnectError, isCursorSdkConnectionStalledError } from "./cursor-provider-errors.js";
import { CURSOR_RIPGREP_ENV, isBundledCursorRipgrepPath, isCursorRipgrepBinary } from "./cursor-ripgrep-path.js";
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

// Cursor's local runtime resolves one ripgrep binary and spawns it for Grep and Glob and for walks
// it starts by itself, for example the LS executor behind its `ls` tool and the workspace walk
// (ignore files, rules, skills and nested AGENTS.md, in any git checkout and in any directory with a
// `.cursor/rules` folder in it or an ancestor). Those walks use the SDK's ripwalk stream (`sy8` in
// dist/bundled/index.js), which arms its `processExit` promise with `child.on('error', reject)` when
// it spawns; its line generator (`IE0`) awaits that promise only after stdout has ended, and only
// when no line was read. When ripgrep cannot start, stdout fails first
// (`ERR_STREAM_PREMATURE_CLOSE`), so `processExit` rejects with no handler and the spawn error
// surfaces only as an unhandled rejection, which exits omp. Bun reports it as an asynchronous
// 'error' event with syscall `spawn <file>`: ENOENT for a missing binary (for one that exists, a
// missing working directory or interpreter), EACCES for a file that is not executable or is a
// directory (for an executable file, a working directory the process cannot enter or an interpreter
// that is not executable).
//
// On 1.0.34 the other spawn sites that were measured observe their spawn errors, so none reaches this
// guard: the local shell (its exec replay cache forwards the error to the model; 1.0.32's dropped it),
// the sandboxed shell, Grep and Glob, stdio MCP servers, hooks, and git. Other spawn sites were not
// measured. One is known to exist and is not covered: with local sandboxing, a ripwalk whose call
// carries a workspace sandbox policy (the LS executor passes one) spawns the SDK's sandbox helper
// (`cursorsandbox`, through `uW` and `tC8`) and hands ripgrep to it as an argument, so a helper that
// cannot start is a spawn failure of a file that is not ripgrep.
//
// A spawn error names the spawned file in its syscall (`spawn <file>`).
function getSpawnedFile(error: NodeJS.ErrnoException): string | undefined {
	const { syscall } = error;
	return typeof syscall === "string" && syscall.startsWith("spawn ") ? syscall.slice("spawn ".length) : undefined;
}

interface CursorSdkRipgrepSpawnFailure {
	readonly error: NodeJS.ErrnoException;
	readonly code: string;
	readonly file: string;
}

function getCursorSdkRipgrepSpawnFailure(error: unknown): CursorSdkRipgrepSpawnFailure | undefined {
	if (!(error instanceof Error) || !CURSOR_SDK_DIST_STACK_FRAME.test(error.stack ?? "")) return undefined;
	const { code } = error as NodeJS.ErrnoException;
	if (typeof code !== "string") return undefined;
	const file = getSpawnedFile(error);
	return file !== undefined && isCursorRipgrepBinary(file) ? { error, code, file } : undefined;
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
	if (getCursorSdkRipgrepSpawnFailure(error)) return hasActiveGuard();
	// RetriableError "Connection stalled" / "Connection stalled repeatedly" is not a ConnectError; suppress during active turns only.
	if (isCursorSdkConnectionStalledError(error)) return activeProviderTurns.size > 0;
	const classification = classifyCursorConnectError(error);
	if (!classification) return false;
	if (classification.kind === "abort") return hasActiveAbortSuppression();
	if (activeProviderTurns.size === 0) return false;
	return classification.source === "cursor-sdk-stack" || classification.source === "cursor-backend-details";
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

// What to tell the user about the ripgrep that failed to start. Node and Bun emit only EACCES, EAGAIN,
// EMFILE, ENFILE and ENOENT as asynchronous spawn errors (every other errno throws synchronously, so
// it never reaches this guard). EAGAIN, EMFILE and ENFILE are a process or open-file limit and say
// nothing about the binary. A file that exists cannot fail with ENOENT for being missing, and a
// regular file that is executable cannot fail with EACCES for not being executable, so those point at
// the working directory it was spawned in (or its interpreter). Otherwise the variable names a user
// override only when it names the failing file and that file is not the SDK's platform-package
// binary: ensureCursorRipgrepPath writes that path into the variable itself when it is unset (while
// the binary is executable), so it is not an override to unset, and the fix is to restore the binary.
const RESOURCE_ERRNO_CODES: Record<string, true> = { EAGAIN: true, EMFILE: true, ENFILE: true };

function isExecutableRegularFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function describeRipgrepSpawnFailure({ code, file }: CursorSdkRipgrepSpawnFailure): string {
	if (Object.hasOwn(RESOURCE_ERRNO_CODES, code)) {
		return `The system could not start ${file} (${code}): a process or open-file limit, not a problem with the binary.`;
	}
	if (code === "ENOENT" && existsSync(file)) {
		return `${file} exists, so the ENOENT is not about the binary itself: the working directory Cursor spawned it in may no longer exist, or the binary's interpreter may be missing.`;
	}
	if (code === "EACCES" && isExecutableRegularFile(file)) {
		return `${file} is an executable file, so the EACCES is not about the binary itself: the working directory Cursor spawned it in may not be accessible, or the binary's interpreter may not be executable.`;
	}
	if (file === process.env[CURSOR_RIPGREP_ENV] && !isBundledCursorRipgrepPath(file)) {
		return `${CURSOR_RIPGREP_ENV} overrides the ripgrep Cursor runs and names this file. Fix it, or unset it to use the SDK's bundled ripgrep, then restart omp.`;
	}
	return `This is the SDK's bundled ripgrep or one found on PATH, not a ${CURSOR_RIPGREP_ENV} override. Make sure it exists and is executable, or reinstall @cursor/sdk, then restart omp.`;
}

function reportContainedCursorSdkRipgrepSpawnFailure(failure: CursorSdkRipgrepSpawnFailure): void {
	const { error, code, file } = failure;
	logger.warn(`Cursor's ripgrep failed to start (${file}); contained its unhandled rejection.`, {
		error: error.message,
		code,
		syscall: error.syscall,
		path: file,
		hint: describeRipgrepSpawnFailure(failure),
	});
}

// omp's postmortem owns the process `unhandledRejection` listener and exits on any rejection no
// interceptor claims. Bun calls process error listeners directly instead of through
// `process.emit`, so under omp the emit patch never sees a rejection; this interceptor is what
// keeps the host alive.
function interceptHostUnhandledRejection(reason: unknown): boolean {
	if (!shouldSuppressProcessError("unhandledRejection", [reason])) return false;
	const ripgrepFailure = getCursorSdkRipgrepSpawnFailure(reason);
	if (ripgrepFailure) reportContainedCursorSdkRipgrepSpawnFailure(ripgrepFailure);
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
