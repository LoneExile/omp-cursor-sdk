import { AsyncLocalStorage } from "node:async_hooks";
import { isUtf8 } from "node:buffer";

// Evidence (installed @cursor/sdk 1.0.34 esm, cjs and bun-bundled builds, locked by
// test/cursor-sdk-output-filter-contract.test.ts):
// - Every SDK log line is one `console.log` (INFO/DEBUG) or `console.warn` (WARN) call with ONE
//   complete string argument. The logger prints `HH:MM:SS.mmm INFO  <message>[ ctx=<path>][ meta={...}]`,
//   with SGR color sequences when colors are on. The `[hooks]` frames are one
//   `console.warn("[hooks] <text>")` through the SDK's default hook logger, or a direct `console.warn`.
// - Under Node, `console` writes each message to process.stdout/stderr as one `string + "\n"` write.
//   Under Bun (omp's runtime) `console.*` never reaches `process.stdout.write`, so the console
//   methods are the filter point there; omp's ACP mode re-routes `console.log` to
//   `process.stderr.write`, so the stream write is a filter point too.
//
// This wraps the whole process's output path, so it only ever acts on a COMPLETE, VERIFIED frame
// (exact templates below) or inside a `suppressCursorSdkOutput` creation window. Everything else is
// forwarded in the same call, with the same arguments, `this`, return value and callbacks: nothing
// is buffered, delayed, reordered or re-encoded. A frame split across writes is therefore forwarded
// unfiltered (visible noise) rather than held back.
//
// Verified frames come in two kinds. Noise is dropped. A hook warning carries information a user may
// need (a hook config was refused or ignored) but is not terminal output: it is handed to the divert
// target the host registered with the process lease, and only forwarded when there is none.

// Process-global, versioned state: omp re-runs the extension factory per registration and can
// re-evaluate this module. Sink ownership and creation-window attribution must be shared by
// every evaluation, not recreated by each.
const STATE = Symbol.for("omp-cursor-sdk:output-filter:v1");
const state = (process[STATE] ??= {
	suppression: new AsyncLocalStorage(),
	activeScopes: 0,
	installs: 0,
	sinks: undefined,
	processLease: undefined,
	divertHookWarning: undefined,
	diverting: false,
});

// Larger frames are forwarded unchanged. Verified SDK frames are far smaller; the inventory
// frame carries at most 40 short skill entries.
const MAX_FRAME_LENGTH = 16 * 1024;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

const NOISE = "noise";
const HOOK_WARNING = "hookWarning";

// Exact INFO messages the SDK logs on startup/reload (`logger.info(ctx, "<message>", meta)`).
export const CURSOR_SDK_STARTUP_NOISE_PATTERNS = [
	"managed_skills.startup_inventory",
	"managed_skills.removed",
	"CursorPluginsAgentSkillsService load completed",
	"LocalCursorRulesService load completed",
	"AgentSkillsCursorRulesService load completed",
];

const SGR_SEQUENCE = /\x1b\[[\d;]*m/g;
const INFO_PREFIX = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3} INFO  /;
const INFO_PREFIX_LENGTH = "00:00:00.000 INFO  ".length;
const INFO_TAIL = /^(?: ctx=\S+)?(?: meta=\{.*\})?$/;

// `[hooks] ${message}` from the SDK's default hook logger. Fixed compatibility notices stay exact;
// only the quoted event name varies in the two event templates.
const HOOK_NOTICES = new Set([
	...["startup", "resume", "clear", "compact"].map(
		(matcher) => `[hooks] SessionStart trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`,
	),
	...["manual", "auto"].map(
		(matcher) => `[hooks] PreCompact trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`,
	),
	'[hooks] Tool "Glob" is not supported in Cursor and will be ignored',
]);
const HOOK_EVENT_NOTICES = [
	/^\[hooks\] Unknown Claude Code event "[^"\r\n]+", skipping$/,
	/^\[hooks\] Claude Code event "[^"\r\n]+" is not supported in Cursor and will be ignored$/,
];

// The SDK's other `[hooks]` warnings: config that was refused, ignored or deprecated. Each template is
// pinned to the installed SDK by the contract test; an unrecognized `[hooks]` line is forwarded as is.
const HOOK_DEPRECATION =
	"[hooks] DEPRECATION WARNING: 'stop_hook_loop_limit' is deprecated. Use 'loop_limit' on individual hook scripts instead. The configured value is being ignored.";
const HOOK_WARNINGS = [
	/^\[hooks\] Hook timeout of \S+s is very long \(>1 hour\)$/,
	/^\[hooks\] Refusing to load [^\r\n]+ config via symlink path: [^\r\n]+$/,
	/^\[hooks\] All tools in matcher "[^\r\n]+" are unsupported, skipping hooks$/,
	/^\[hooks\] Claude Code event "[^\r\n]+" has invalid value \(expected array\), skipping$/,
];

// `console.error(`Error initializing ignore mapping for ${file}:`, error)` where the ripgrep path was
// not configured yet. Other causes of an ignore-mapping failure (spawn errors, permissions) stay visible.
const IGNORE_MAPPING_PREFIX = /^Error initializing ignore mapping for [^\r\n]+:$/;
const RIPGREP_UNCONFIGURED = "Ripgrep path not configured. Call configureRipgrepPath() at startup.";

// Every verified frame contains one of these markers (colored INFO frames keep "INFO " followed by a
// reset sequence), so everything else is rejected by two vectorized scans, before any allocation.
function hasFrameMarker(text) {
	return text.includes("INFO ") || text.includes("[hooks]");
}

function stripSgr(text) {
	return text.includes("\x1b") ? text.replace(SGR_SEQUENCE, "") : text;
}

function classifyLine(line) {
	const plain = stripSgr(line);
	// Only SGR may appear in a frame; cursor movement or other control sequences are not SDK output.
	if (plain.includes("\x1b")) return undefined;
	if (plain.startsWith("[hooks] ")) {
		if (HOOK_NOTICES.has(plain) || HOOK_EVENT_NOTICES.some((pattern) => pattern.test(plain))) return NOISE;
		if (plain === HOOK_DEPRECATION || HOOK_WARNINGS.some((pattern) => pattern.test(plain))) return HOOK_WARNING;
		return undefined;
	}
	if (!INFO_PREFIX.test(plain)) return undefined;
	const message = plain.slice(INFO_PREFIX_LENGTH);
	const known = CURSOR_SDK_STARTUP_NOISE_PATTERNS.some(
		(pattern) => message.startsWith(pattern) && INFO_TAIL.test(message.slice(pattern.length)),
	);
	return known ? NOISE : undefined;
}

function withoutLineEnd(text) {
	return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

// Kind of exactly one complete frame (one optional trailing line break), or undefined.
function classifyFrame(text) {
	if (typeof text !== "string" || text.length > MAX_FRAME_LENGTH || !hasFrameMarker(text)) return undefined;
	return classifyLine(withoutLineEnd(text));
}

/** True when `text` is exactly one complete verified SDK noise frame (one optional trailing line break). */
export function isCursorSdkStartupNoise(text) {
	return classifyFrame(text) === NOISE;
}

/** True when `text` is exactly one complete verified SDK `[hooks]` warning frame. */
export function isCursorSdkHookWarning(text) {
	return classifyFrame(text) === HOOK_WARNING;
}

// Kind of one console call. One string argument is how the SDK's printer and hook logger call console;
// the ignore-mapping report is the only two-argument frame (template, Error).
function classifyConsoleCall(args) {
	const first = args[0];
	if (typeof first !== "string") return undefined;
	if (args.length === 1) {
		return first.length <= MAX_FRAME_LENGTH && hasFrameMarker(first) ? classifyLine(first) : undefined;
	}
	const unconfiguredRipgrep =
		args.length === 2 &&
		IGNORE_MAPPING_PREFIX.test(first) &&
		args[1] instanceof Error &&
		args[1].message === RIPGREP_UNCONFIGURED;
	return unconfiguredRipgrep ? NOISE : undefined;
}

function startsLikeFrame(code) {
	// ESC (colored frame), "[" ([hooks]), or a digit (timestamp).
	return code === 27 || code === 91 || (code >= 48 && code <= 57);
}

// The text of a write chunk that could be one complete frame, else undefined. One complete frame per
// write call is how the SDK's console output arrives: only chunks that end in a line feed, start like a
// frame and are small are ever decoded; every other chunk costs two character reads.
function frameCandidateText(chunk, encoding) {
	if (typeof chunk === "string") {
		const length = chunk.length;
		if (length === 0 || length > MAX_FRAME_LENGTH || chunk.charCodeAt(length - 1) !== 10) return undefined;
		// Frames are ASCII-compatible UTF-8; a string written with another encoding is never examined.
		const utf8 = encoding === undefined || encoding === "utf8" || encoding === "utf-8" || typeof encoding === "function";
		return utf8 && startsLikeFrame(chunk.charCodeAt(0)) ? chunk : undefined;
	}
	if (chunk instanceof Uint8Array) {
		const length = chunk.length;
		if (length === 0 || length > MAX_FRAME_LENGTH || chunk[length - 1] !== 10 || !startsLikeFrame(chunk[0])) return undefined;
		return Buffer.from(chunk.buffer, chunk.byteOffset, length).toString("utf8");
	}
	return undefined;
}

export function isCursorSdkOutputSuppressed() {
	return state.suppression.getStore()?.active === true;
}

// Fast path: the async-context lookup only happens while a creation window is open anywhere.
function inCreationWindow() {
	return state.activeScopes > 0 && isCursorSdkOutputSuppressed();
}

/**
 * Mutes ALL output of the operation's async context until the operation settles. Detached SDK work
 * (file watchers, completion callbacks) inherits the context but not the mute: the scope is
 * deactivated when the operation returns, rejects or throws, so the mute never outlives creation.
 * Hook warnings inside the window are still diverted rather than lost.
 */
export function suppressCursorSdkOutput(operation) {
	const scope = { active: true };
	state.activeScopes += 1;
	const release = () => {
		if (!scope.active) return;
		scope.active = false;
		state.activeScopes -= 1;
	};
	return state.suppression.run(scope, () => {
		try {
			const result = operation();
			if (result && typeof result.then === "function") return Promise.resolve(result).finally(release);
			release();
			return result;
		} catch (error) {
			release();
			throw error;
		}
	});
}

// Hands a verified hook warning to the registered divert target. False when there is none, when it
// throws, or when it re-enters the filter (a target that itself prints to the console): the caller
// then keeps the warning visible instead of losing it.
function tryDivertHookWarning(text) {
	const divert = state.divertHookWarning;
	if (!divert || state.diverting) return false;
	state.diverting = true;
	try {
		divert(stripSgr(withoutLineEnd(text)));
		return true;
	} catch {
		return false;
	} finally {
		state.diverting = false;
	}
}

function createFilteredWrite(write, sink) {
	return function filteredWrite(chunk, encoding, callback) {
		if (sink.active) {
			const text = frameCandidateText(chunk, encoding);
			const kind = text === undefined ? undefined : classifyFrame(text);
			// Decoding is lossy for invalid UTF-8; only a chunk that is valid UTF-8 can be a frame.
			const verified = kind !== undefined && (typeof chunk === "string" || isUtf8(chunk));
			if ((verified && (kind === NOISE || tryDivertHookWarning(text))) || inCreationWindow()) {
				const done = typeof encoding === "function" ? encoding : callback;
				if (typeof done === "function") process.nextTick(done);
				return true;
			}
		}
		return Reflect.apply(write, this, arguments);
	};
}

function createFilteredConsoleMethod(method, sink) {
	return function filteredConsoleMethod() {
		if (sink.active) {
			const kind = classifyConsoleCall(arguments);
			if (kind === NOISE || (kind === HOOK_WARNING && tryDivertHookWarning(arguments[0])) || inCreationWindow()) return;
		}
		return Reflect.apply(method, this, arguments);
	};
}

// Replaces target[key] and returns a restore that only undoes OUR wrapper: a later owner that wrapped
// or replaced the member keeps it, and our retained wrapper turns into a transparent delegate.
function wrapMember(target, key, create) {
	const original = target[key];
	if (typeof original !== "function") return () => {};
	const wrapper = create(original);
	target[key] = wrapper;
	return () => {
		if (target[key] === wrapper) target[key] = original;
	};
}

function attachSinks() {
	const sink = { active: true };
	const restores = [];
	for (const stream of [process.stdout, process.stderr]) {
		restores.push(wrapMember(stream, "write", (write) => createFilteredWrite(write, sink)));
	}
	for (const method of CONSOLE_METHODS) {
		restores.push(wrapMember(console, method, (original) => createFilteredConsoleMethod(original, sink)));
	}
	return {
		detach() {
			sink.active = false;
			for (const restore of restores) restore();
		},
	};
}

/** Reference-counted install shared by maintainer scripts and the process-lifetime lease. */
export function installCursorSdkOutputFilter() {
	if (state.installs === 0) state.sinks = attachSinks();
	state.installs += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.installs -= 1;
		if (state.installs > 0) return;
		const sinks = state.sinks;
		state.sinks = undefined;
		sinks?.detach();
	};
}

/**
 * One lease for the life of the process, taken when the SDK is first loaded. Idempotent across
 * per-registration factory re-runs and module re-evaluation. SDK work outlives provider turns
 * (rules/skills loads, watchers, `agent.reload()`), so per-turn installs alone leave gaps.
 * The lease holds no timers, buffers or listeners, so nothing needs flushing at exit.
 *
 * `options.divertHookWarning` receives each verified SDK `[hooks]` warning (without line ending or
 * colors) instead of the terminal. The most recent target wins.
 */
export function installCursorSdkProcessOutputFilter(options) {
	if (typeof options?.divertHookWarning === "function") state.divertHookWarning = options.divertHookWarning;
	state.processLease ??= installCursorSdkOutputFilter();
}

// Canonical test cleanup only; production owns the process lease until exit.
export const __testUtils = {
	resetProcessOutputFilter() {
		const lease = state.processLease;
		state.processLease = undefined;
		state.divertHookWarning = undefined;
		lease?.();
	},
};
