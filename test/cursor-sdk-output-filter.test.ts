import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger } from "@oh-my-pi/pi-utils";
import {
	__testUtils,
	CURSOR_SDK_STARTUP_NOISE_PATTERNS,
	installCursorSdkOutputFilter,
	installCursorSdkProcessOutputFilter as installSharedProcessOutputFilter,
	isCursorSdkHookWarning,
	isCursorSdkOutputSuppressed,
	isCursorSdkStartupNoise,
	suppressCursorSdkOutput,
} from "../shared/cursor-sdk-output-filter.mjs";
import type * as OutputFilterModule from "../shared/cursor-sdk-output-filter.mjs";
import { installCursorSdkProcessOutputFilter as installOmpProcessOutputFilter } from "../src/cursor-sdk-output-filter.js";
import { installCursorSdkOutputFilter as installScriptCursorSdkOutputFilter } from "../scripts/lib/cursor-sdk-output-filter.mjs";
import {
	CONSOLE_METHODS,
	captureProcessOutput,
	writtenText,
	type ProcessOutputCapture,
} from "./helpers/process-output-capture.js";
import { COLORED_INFO_FRAME as COLORED_INFO, PLAIN_INFO_FRAME as PLAIN_INFO } from "./helpers/cursor-sdk-output-frames.js";

const HOOK_NOTICE = '[hooks] SessionStart trigger matcher "startup" is not supported in Cursor, hooks will fire for all triggers';
const IGNORE_MAPPING_MESSAGE = "Error initializing ignore mapping for .gitignore:";
const RIPGREP_UNCONFIGURED = "Ripgrep path not configured. Call configureRipgrepPath() at startup.";
// The SDK's hook warnings that carry information: filtered out of the terminal, handed to a divert target.
const HOOK_WARNINGS = [
	"[hooks] Hook timeout of 7200s is very long (>1 hour)",
	"[hooks] DEPRECATION WARNING: 'stop_hook_loop_limit' is deprecated. Use 'loop_limit' on individual hook scripts instead. The configured value is being ignored.",
	"[hooks] Refusing to load user config via symlink path: /home/u/.cursor/hooks.json",
	'[hooks] All tools in matcher "Glob" are unsupported, skipping hooks',
	'[hooks] Claude Code event "SessionStart" has invalid value (expected array), skipping',
];

type StreamName = "stdout" | "stderr";
const STREAMS: readonly StreamName[] = ["stdout", "stderr"];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

// Promise.withResolvers is outside this repo's test tsconfig lib.
function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** process.nextTick callbacks queued before this call have run once it resolves (the queue is FIFO). */
async function afterQueuedTicks(): Promise<void> {
	const { promise, resolve } = deferred();
	process.nextTick(() => resolve());
	await promise;
}

describe("verified SDK noise frames", () => {
	it("recognizes every verified INFO message, with and without ctx, meta, colors and line ending", () => {
		const recognized: string[] = [];
		const missed: string[] = [];
		for (const message of CURSOR_SDK_STARTUP_NOISE_PATTERNS) {
			for (const suffix of ["", " ctx=syncBuiltinSkills", ' meta={skill_id: "clone"}', " ctx=loadRules meta={durationMs: 12}"]) {
				for (const lineEnd of ["", "\n", "\r\n"]) {
					const frame = `23:59:59.999 INFO  ${message}${suffix}${lineEnd}`;
					(isCursorSdkStartupNoise(frame) ? recognized : missed).push(frame);
				}
			}
		}
		expect(missed).toEqual([]);
		expect(recognized).toHaveLength(CURSOR_SDK_STARTUP_NOISE_PATTERNS.length * 12);
		expect(isCursorSdkStartupNoise(COLORED_INFO)).toBe(true);
		expect(isCursorSdkStartupNoise(`${COLORED_INFO}\n`)).toBe(true);
	});

	it("recognizes the verified hook-compatibility notices, including unknown event names", () => {
		const verified = [
			...["startup", "resume", "clear", "compact"].map(
				(matcher) => `[hooks] SessionStart trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`,
			),
			...["manual", "auto"].map(
				(matcher) => `[hooks] PreCompact trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`,
			),
			'[hooks] Tool "Glob" is not supported in Cursor and will be ignored',
			'[hooks] Claude Code event "Notification" is not supported in Cursor and will be ignored',
			'[hooks] Claude Code event "FutureUnsupportedEvent42" is not supported in Cursor and will be ignored',
			'[hooks] Unknown Claude Code event "InstructionsLoaded", skipping',
			'[hooks] Unknown Claude Code event "FutureClaudeEvent42", skipping',
		];
		expect(verified.filter((notice) => !isCursorSdkStartupNoise(notice))).toEqual([]);
		expect(verified.filter((notice) => !isCursorSdkStartupNoise(`${notice}\n`))).toEqual([]);
	});

	it("recognizes the verified hook warnings as warnings, never as noise, and rejects lookalikes", () => {
		expect(HOOK_WARNINGS.filter((warning) => !isCursorSdkHookWarning(warning) || isCursorSdkStartupNoise(warning))).toEqual([]);
		expect(HOOK_WARNINGS.filter((warning) => !isCursorSdkHookWarning(`\u001b[33m${warning}\u001b[0m\r\n`))).toEqual([]);
		const lookalikes = [
			"",
			"[hooks]",
			"[hooks] ",
			"[hooks] a warning nobody reviewed",
			"[hooks] Hook timeout of s is very long (>1 hour)",
			"[hooks] Hook timeout of 7200s is very long (>1 hour) and more",
			"[hooks] Refusing to load  config via symlink path: ",
			'[hooks] All tools in matcher "" are unsupported, skipping hooks',
			'[hooks] Unknown Claude Code event "Future" failed to load: denied',
			`x ${HOOK_WARNINGS[0]}`,
			`${HOOK_WARNINGS[0]}\nsecond line`,
			`\u001b[2J${HOOK_WARNINGS[0]}`,
			PLAIN_INFO,
			HOOK_NOTICE,
		];
		expect(lookalikes.filter((text) => isCursorSdkHookWarning(text))).toEqual([]);
	});

	it("rejects near-misses and lookalikes, including the old substring semantics", () => {
		const lookalikes = [
			"",
			"managed_skills.removed",
			"prefix 12:34:56.789 INFO  managed_skills.removed",
			"managed_skills.example load completed",
			"12:34:56.789 INFO  managed_skills.other",
			"12:34:56.789 INFO  managed_skills.removed_extra",
			"12:34:56.789 INFO  LocalCursorRulesService load completed extra words",
			"12:34:56.789 INFO  LocalCursorRulesService load completed ctx=a b",
			"12:34:56.789 WARN  LocalCursorRulesService load completed",
			"12:34:56.789 ERROR LocalCursorRulesService load completed",
			"25:34:56.789 INFO  LocalCursorRulesService load completed",
			"12:34:56 INFO  LocalCursorRulesService load completed",
			"12:34:56.789 INFO LocalCursorRulesService load completed",
			"12:34:56.789 INFO  my-app started",
			`my-tool: ${HOOK_NOTICE}`,
			`${HOOK_NOTICE} (copy)`,
			"[hooks]",
			"[hooks] Hook timeout of 9999s is very long (>1 hour)",
			"[hooks] DEPRECATION WARNING: 'stop_hook_loop_limit' is deprecated. Use 'loop_limit' on individual hook scripts instead.",
			"[hooks] Refusing to load user config via symlink path: /unsafe",
			'[hooks] All tools in matcher "Glob" are unsupported, skipping hooks',
			'[hooks] Claude Code event "SessionStart" has invalid value (expected array), skipping',
			'[hooks] SessionStart trigger matcher "other" is not supported in Cursor, hooks will fire for all triggers',
			'[hooks] Unknown Claude Code event "", skipping',
			'[hooks] Unknown Claude Code event "bad"quote", skipping',
			'[hooks] Unknown Claude Code event "Future" failed to load: denied',
			'[hooks] Claude Code event "Future" is not supported in Cursor and will be ignored: failure',
			`\u001b[2J${PLAIN_INFO}`,
			`${PLAIN_INFO}\nsecond line`,
			`${PLAIN_INFO}\n${PLAIN_INFO}\n`,
			`${PLAIN_INFO}\rcarriage return`,
			// Valid grammar but over the 16 KiB frame bound: never examined, always forwarded.
			`12:34:56.789 INFO  LocalCursorRulesService load completed meta={${"x".repeat(20_000)}}`,
		];
		expect(lookalikes.filter((text) => isCursorSdkStartupNoise(text))).toEqual([]);
	});
});

describe("process output filter", () => {
	let capture: ProcessOutputCapture;
	let original: unknown[];
	const diverted: string[] = [];

	// Install through the shared module with a recording divert target; production's target is omp's file logger.
	function installCursorSdkProcessOutputFilter(): void {
		installSharedProcessOutputFilter({
			divertHookWarning: (message) => {
				diverted.push(message);
			},
		});
	}

	// A lease left by another suite (anything that ran the extension factory) would make installs below no-ops.
	// Recorders answer `false` (backpressure) so a forwarded write is distinguishable from a dropped frame (`true`).
	beforeEach(() => {
		__testUtils.resetProcessOutputFilter();
		diverted.length = 0;
		capture = captureProcessOutput({ writeResult: false });
		original = members();
	});
	afterEach(() => {
		__testUtils.resetProcessOutputFilter();
		capture.restore();
	});

	function members(): unknown[] {
		return [process.stdout.write, process.stderr.write, ...CONSOLE_METHODS.map((method) => console[method])];
	}

	function expectMembers(expected: unknown[]): void {
		const actual = members();
		expect(actual).toHaveLength(expected.length);
		actual.forEach((member, index) => expect(member).toBe(expected[index]));
	}

	function expectWrapped(): void {
		const actual = members();
		actual.forEach((member, index) => expect(member).not.toBe(original[index]));
	}

	function write(stream: StreamName, ...args: unknown[]): boolean {
		return (process[stream].write as (...writeArgs: unknown[]) => boolean).apply(process[stream], args);
	}

	function expectNothingReached(): void {
		expect(capture.stdout).toHaveLength(0);
		expect(capture.stderr).toHaveLength(0);
		expect(capture.consoleCalls).toHaveLength(0);
	}

	describe("process-lifetime lease", () => {
		it("installs once across repeated initialization and re-evaluated module instances", async () => {
			const listeners = { exit: process.listenerCount("exit"), beforeExit: process.listenerCount("beforeExit") };
			installCursorSdkProcessOutputFilter();
			const installed = members();
			expectWrapped();
			installCursorSdkProcessOutputFilter();
			expectMembers(installed);

			// A query string makes the runtime evaluate the module a second time, as an omp module reload does.
			// The static import above cannot express that, so it is the one dynamic import here.
			const fresh = (await import(`../shared/cursor-sdk-output-filter.mjs?reevaluated=${Date.now()}`)) as typeof OutputFilterModule;
			expect(fresh.installCursorSdkProcessOutputFilter).not.toBe(installCursorSdkProcessOutputFilter);
			fresh.installCursorSdkProcessOutputFilter();
			expectMembers(installed);

			// Creation-window attribution is shared too: the other evaluation's window is honored by the first one's sinks.
			fresh.suppressCursorSdkOutput(() => {
				expect(isCursorSdkOutputSuppressed()).toBe(true);
				write("stdout", "muted by the other evaluation\n");
				console.log("muted by the other evaluation");
			});
			expectNothingReached();
			suppressCursorSdkOutput(() => expect(fresh.isCursorSdkOutputSuppressed()).toBe(true));

			// The lease holds no timers, buffers or listeners, so nothing is left to flush at exit.
			expect(process.listenerCount("exit")).toBe(listeners.exit);
			expect(process.listenerCount("beforeExit")).toBe(listeners.beforeExit);

			// One lease serves every evaluation: the other evaluation can release it, and a later init takes it again.
			fresh.__testUtils.resetProcessOutputFilter();
			expectMembers(original);
			installCursorSdkProcessOutputFilter();
			expectWrapped();
			write("stdout", `${PLAIN_INFO}\n`);
			expectNothingReached();
		});

		it("filters a complete SDK INFO frame written outside any turn, on every channel", async () => {
			installCursorSdkProcessOutputFilter();
			const callbacks: string[] = [];
			const frames = [PLAIN_INFO, COLORED_INFO];
			for (const stream of STREAMS) {
				for (const frame of frames) {
					for (const lineEnd of ["\n", "\r\n"]) {
						const text = frame + lineEnd;
						expect(write(stream, text)).toBe(true);
						expect(write(stream, Buffer.from(text))).toBe(true);
						expect(write(stream, new Uint8Array(Buffer.from(text)))).toBe(true);
						expect(write(stream, text, "utf8", () => callbacks.push(`${stream}:encoding`))).toBe(true);
						expect(write(stream, text, () => callbacks.push(`${stream}:callback`))).toBe(true);
					}
				}
			}
			for (const method of CONSOLE_METHODS) {
				for (const frame of frames) console[method](frame);
			}
			expectNothingReached();
			// Callbacks are honored like a real stream's: asynchronously, never inline.
			expect(callbacks).toEqual([]);
			await afterQueuedTicks();
			expect(callbacks).toHaveLength(STREAMS.length * frames.length * 2 * 2);
			expect(callbacks.filter((entry) => entry.endsWith(":encoding"))).toHaveLength(STREAMS.length * frames.length * 2);
		});

		it("filters the SDK's hook notices and the unconfigured-ripgrep ignore-mapping error on console", () => {
			installCursorSdkProcessOutputFilter();
			console.warn(HOOK_NOTICE);
			console.log('[hooks] Unknown Claude Code event "FutureClaudeEvent42", skipping');
			console.error(IGNORE_MAPPING_MESSAGE, new Error(RIPGREP_UNCONFIGURED));
			write("stderr", `${HOOK_NOTICE}\n`);
			expect(diverted).toEqual([]);
			expectNothingReached();
		});

		for (const [label, chunk] of [
			["a partial CSI introducer", "\u001b[3"],
			["partial SGR text", "\u001b[31mred"],
			["a partial colored frame prefix", "\u001b[2m12:34:56.789\u001b[0m \u001b[34mINFO"],
			["a bare timestamp prefix", "18:05:"],
			["the first half of a frame", `${PLAIN_INFO}\n`.slice(0, 25)],
			["the second half of a frame", `${PLAIN_INFO}\n`.slice(25)],
			["a TUI repaint with cursor addressing", "\u001b[?2026h\u001b[1;1Hhello\u001b[K\r\n\u001b[?2026l"],
			["a TUI line ending in a newline", "\u001b[1;1Hhello\u001b[K\n"],
			["a non-SDK line containing a hook notice", `my-tool: ${HOOK_NOTICE}\n`],
			["a non-SDK [hooks] line", "[hooks] my own plugin loaded\n"],
			["a non-SDK INFO line", "12:34:56.789 INFO  my-app started\n"],
			["bare SDK message text", "managed_skills.removed\n"],
			["conversation text quoting a completion", "LocalCursorRulesService load completed\n"],
			["a frame followed by more output", `${PLAIN_INFO}\nnext line\n`],
			["two frames in one write", `${PLAIN_INFO}\n${PLAIN_INFO}\n`],
			["an oversized frame-shaped chunk", `12:34:56.789 INFO  LocalCursorRulesService load completed meta={${"x".repeat(20_000)}}\n`],
			["an empty string", ""],
			["a partial buffer", Buffer.from("\u001b[31")],
			["a buffer holding a non-SDK line", Buffer.from("[hooks] other\n")],
			["invalid UTF-8 ending in a newline", Buffer.from([0x31, 0xff, 0xfe, 0x0a])],
			["a Uint8Array holding half a frame", new Uint8Array(Buffer.from(`${PLAIN_INFO}\n`.slice(0, 30)))],
		] as const) {
			it(`forwards ${label} immediately and untouched on both streams`, () => {
				installCursorSdkProcessOutputFilter();
				for (const stream of STREAMS) {
					const writeVariants: unknown[][] = [[], ["utf8", undefined], [undefined, () => {}]];
					for (const extra of writeVariants) {
						capture.clear();
						const result = write(stream, chunk, ...extra);
						// The recorder ran before write() returned: nothing was held back or deferred.
						expect(capture[stream]).toHaveLength(1);
						const call = capture[stream][0]!;
						expect(call.chunk).toBe(chunk);
						expect(call.argCount).toBe(1 + extra.length);
						expect(call.encoding).toBe(extra[0]);
						expect(call.callback).toBe(extra[1]);
						expect(call.receiver).toBe(process[stream]);
						expect(result).toBe(false);
					}
				}
			});
		}

		it("forwards write callbacks and backpressure answers untouched", () => {
			installCursorSdkProcessOutputFilter();
			const callback = () => {};
			expect(write("stdout", "plain text\n", callback)).toBe(false);
			expect(capture.stdout[0]!.encoding).toBe(callback);
			expect(write("stderr", "plain text\n", "utf8", callback)).toBe(false);
			expect(capture.stderr[0]!.callback).toBe(callback);
		});

		it("forwards ordinary console output with identical arguments and receiver", () => {
			installCursorSdkProcessOutputFilter();
			const payload = { nested: { value: 1 } };
			const error = new Error("EACCES: permission denied");
			const receiver = { custom: true };
			const calls: unknown[][] = [
				[],
				["plain message"],
				["two", payload, 3],
				[HOOK_NOTICE.replace("startup", "other")],
				["[hooks] a warning nobody reviewed"],
				[PLAIN_INFO, payload],
				[IGNORE_MAPPING_MESSAGE, error],
				[IGNORE_MAPPING_MESSAGE, RIPGREP_UNCONFIGURED],
				[IGNORE_MAPPING_MESSAGE, new Error(RIPGREP_UNCONFIGURED), "extra"],
				[Buffer.from(`${PLAIN_INFO}\n`)],
				[`${PLAIN_INFO}\n${PLAIN_INFO}`],
			];
			for (const method of CONSOLE_METHODS) {
				capture.clear();
				for (const args of calls) (console[method] as (...a: unknown[]) => unknown).apply(receiver, args);
				expect(capture.consoleCalls).toHaveLength(calls.length);
				capture.consoleCalls.forEach((call, index) => {
					expect(call.method).toBe(method);
					expect(call.receiver).toBe(receiver);
					expect(call.args).toHaveLength(calls[index]!.length);
					call.args.forEach((arg, argIndex) => expect(arg).toBe(calls[index]![argIndex]));
				});
				expect((console[method] as (...a: unknown[]) => unknown)("returned")).toBeUndefined();
			}
		});
	});

	describe("hook warnings", () => {
		it("diverts every verified warning from console and from complete stream frames, once, without line ending or colors", () => {
			installCursorSdkProcessOutputFilter();
			const expected: string[] = [];
			for (const warning of HOOK_WARNINGS) {
				console.warn(warning);
				write("stderr", `${warning}\n`);
				write("stderr", Buffer.from(`${warning}\r\n`));
				write("stdout", `\u001b[33m${warning}\u001b[0m\n`);
				expected.push(warning, warning, warning, warning);
			}
			expect(diverted).toEqual(expected);
			expectNothingReached();
		});

		it("acknowledges a diverted write like a dropped frame: true now, callback asynchronously", async () => {
			installCursorSdkProcessOutputFilter();
			const callbacks: string[] = [];
			expect(write("stderr", `${HOOK_WARNINGS[0]}\n`, () => callbacks.push("two-argument"))).toBe(true);
			expect(write("stderr", `${HOOK_WARNINGS[0]}\n`, "utf8", () => callbacks.push("three-argument"))).toBe(true);
			expect(callbacks).toEqual([]);
			await afterQueuedTicks();
			expect(callbacks).toEqual(["two-argument", "three-argument"]);
			expect(diverted).toHaveLength(2);
		});

		it("forwards the same warnings untouched when no divert target is registered", () => {
			installSharedProcessOutputFilter();
			for (const warning of HOOK_WARNINGS) {
				console.warn(warning);
				write("stderr", `${warning}\n`);
			}
			expect(capture.consoleCalls.map((call) => call.args)).toEqual(HOOK_WARNINGS.map((warning) => [warning]));
			expect(writtenText(capture.stderr)).toBe(HOOK_WARNINGS.map((warning) => `${warning}\n`).join(""));
		});

		it("keeps the warning visible when the divert target throws", () => {
			installSharedProcessOutputFilter({
				divertHookWarning: () => {
					throw new Error("log transport failed");
				},
			});
			console.warn(HOOK_WARNINGS[0]);
			write("stderr", `${HOOK_WARNINGS[0]}\n`);
			expect(capture.consoleCalls.map((call) => call.args)).toEqual([[HOOK_WARNINGS[0]]]);
			expect(writtenText(capture.stderr)).toBe(`${HOOK_WARNINGS[0]}\n`);
		});

		it("does not recurse when the divert target prints the warning itself", () => {
			let invocations = 0;
			installSharedProcessOutputFilter({
				divertHookWarning: (message) => {
					invocations += 1;
					console.warn(message);
				},
			});
			console.warn(HOOK_WARNINGS[0]);
			// The target's own print is not diverted again: it reaches the console once.
			expect(invocations).toBe(1);
			expect(capture.consoleCalls.map((call) => call.args)).toEqual([[HOOK_WARNINGS[0]]]);
		});

		it("never diverts or alters unrecognized [hooks] lines", () => {
			installCursorSdkProcessOutputFilter();
			const unrecognized = [
				"[hooks] a warning nobody reviewed",
				"[hooks] Hook timeout of s is very long (>1 hour)",
				"[hooks] Hook timeout of 7200s is very long (>1 hour) and more",
				'[hooks] Unknown Claude Code event "Future" failed to load: denied',
				`x ${HOOK_WARNINGS[0]}`,
			];
			for (const line of unrecognized) {
				console.warn(line);
				write("stderr", `${line}\n`);
			}
			expect(diverted).toEqual([]);
			expect(capture.consoleCalls.map((call) => call.args)).toEqual(unrecognized.map((line) => [line]));
			expect(writtenText(capture.stderr)).toBe(unrecognized.map((line) => `${line}\n`).join(""));
		});

		it("diverts a warning emitted inside the creation window instead of losing it, and still mutes everything else", async () => {
			installCursorSdkProcessOutputFilter();
			await suppressCursorSdkOutput(async () => {
				console.warn("muted console");
				console.warn(HOOK_WARNINGS[1]);
				write("stderr", "muted stderr\n");
				write("stderr", `${HOOK_WARNINGS[2]}\n`);
			});
			expect(diverted).toEqual([HOOK_WARNINGS[1], HOOK_WARNINGS[2]]);
			expectNothingReached();
		});

		it("shares the divert target across module instances, where the newest registration wins and reset clears it", async () => {
			installCursorSdkProcessOutputFilter();
			const fresh = (await import(`../shared/cursor-sdk-output-filter.mjs?divert=${Date.now()}`)) as typeof OutputFilterModule;
			const newest: string[] = [];
			fresh.installCursorSdkProcessOutputFilter({
				divertHookWarning: (message) => {
					newest.push(message);
				},
			});
			console.warn(HOOK_WARNINGS[0]);
			expect(newest).toEqual([HOOK_WARNINGS[0]]);
			expect(diverted).toEqual([]);

			fresh.__testUtils.resetProcessOutputFilter();
			installSharedProcessOutputFilter();
			console.warn(HOOK_WARNINGS[0]);
			expect(newest).toHaveLength(1);
			expect(capture.consoleCalls.map((call) => call.args)).toEqual([[HOOK_WARNINGS[0]]]);
		});
	});

	describe("omp wiring", () => {
		it("sends diverted hook warnings to omp's file logger as warnings, and never to the terminal", () => {
			const events: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }> = [];
			const unregister = logger.registerLogSink((event) => {
				events.push({ level: event.level, message: event.message, context: event.context });
			});
			try {
				installOmpProcessOutputFilter();
				installOmpProcessOutputFilter(); // idempotent: still one lease, one target
				console.warn(HOOK_WARNINGS[2]);
				write("stderr", `${HOOK_WARNINGS[0]}\n`);
				console.warn(PLAIN_INFO);
			} finally {
				unregister();
			}
			expect(events).toEqual([
				{ level: "warn", message: HOOK_WARNINGS[2], context: { origin: "@cursor/sdk" } },
				{ level: "warn", message: HOOK_WARNINGS[0], context: { origin: "@cursor/sdk" } },
			]);
			expectNothingReached();
		});
	});

	describe("reference-counted installs (maintainer scripts and the process lease)", () => {
		it("install and fully release the filter when no process lease exists", () => {
			const releaseFirst = installCursorSdkOutputFilter();
			const installed = members();
			expectWrapped();
			const releaseSecond = installCursorSdkOutputFilter();
			expectMembers(installed);
			write("stdout", `${PLAIN_INFO}\n`);
			expectNothingReached();

			releaseFirst();
			releaseFirst(); // releasing twice must not release the other holder
			expectMembers(installed);
			write("stderr", `${PLAIN_INFO}\n`);
			expectNothingReached();

			releaseSecond();
			expectMembers(original);
			write("stdout", `${PLAIN_INFO}\n`);
			expect(writtenText(capture.stdout)).toBe(`${PLAIN_INFO}\n`);
		});

		it("work on top of the process lease and never remove it", () => {
			installCursorSdkProcessOutputFilter();
			const installed = members();
			const releaseTurn = installCursorSdkOutputFilter();
			expectMembers(installed);
			releaseTurn();
			releaseTurn();
			expectMembers(installed);
			write("stdout", `${PLAIN_INFO}\n`);
			console.warn(HOOK_NOTICE);
			expectNothingReached();

			// The filter stays until the last holder is gone, whichever lease outlives the other.
			const lateTurn = installCursorSdkOutputFilter();
			__testUtils.resetProcessOutputFilter();
			expectMembers(installed);
			write("stdout", `${PLAIN_INFO}\n`);
			expectNothingReached();
			lateTurn();
			expectMembers(original);
		});

		it("share one install count with the maintainer script wrapper", () => {
			const releaseProvider = installCursorSdkOutputFilter();
			const installed = members();
			const releaseScript = installScriptCursorSdkOutputFilter();
			expectMembers(installed);
			releaseProvider();
			expectMembers(installed);
			releaseScript();
			expectMembers(original);
		});

		it("do not remove a wrapper another owner installed on top, and leave the retained filter transparent", () => {
			const release = installCursorSdkOutputFilter();
			const filteredStdout = process.stdout.write;
			const filteredLog = console.log;
			const laterStdout = function (this: unknown, ...args: unknown[]): boolean {
				return Reflect.apply(filteredStdout, this, args) as boolean;
			} as typeof process.stdout.write;
			const laterLog = (...args: unknown[]): void => Reflect.apply(filteredLog, console, args);
			process.stdout.write = laterStdout;
			console.log = laterLog;
			release();
			expect(process.stdout.write).toBe(laterStdout);
			expect(console.log).toBe(laterLog);
			// Untouched members are restored; the retained filter no longer filters.
			expect(process.stderr.write).toBe(capture.recorders.stderrWrite);
			expect(console.warn).toBe(capture.recorders.console.warn);
			process.stdout.write(`${PLAIN_INFO}\n` as never);
			console.log(PLAIN_INFO);
			expect(writtenText(capture.stdout)).toBe(`${PLAIN_INFO}\n`);
			expect(capture.consoleCalls.map((call) => call.args)).toEqual([[PLAIN_INFO]]);
		});
	});

	describe("creation window", () => {
		it("mutes the creation operation and never outlives it", async () => {
			installCursorSdkProcessOutputFilter();
			expect(isCursorSdkOutputSuppressed()).toBe(false);
			const creationDone = deferred();
			const detachedDone = deferred();
			const insideState: boolean[] = [];
			const detachedState: boolean[] = [];
			await suppressCursorSdkOutput(async () => {
				insideState.push(isCursorSdkOutputSuppressed());
				console.log("muted console");
				write("stderr", "muted stderr\n");
				// Detached SDK work (a watcher, a completion callback) inherits the async context, but must not inherit the mute.
				void (async () => {
					await creationDone.promise;
					detachedState.push(isCursorSdkOutputSuppressed());
					console.log("VISIBLE detached console");
					write("stdout", "VISIBLE detached stdout\n");
				})().then(detachedDone.resolve, detachedDone.reject);
				await Promise.resolve();
				console.warn("muted after an await inside the window");
			});
			expect(isCursorSdkOutputSuppressed()).toBe(false);
			creationDone.resolve();
			await detachedDone.promise;
			expect(insideState).toEqual([true]);
			expect(detachedState).toEqual([false]);
			expect(capture.consoleCalls.map((call) => call.args)).toEqual([["VISIBLE detached console"]]);
			expect(writtenText(capture.stdout)).toBe("VISIBLE detached stdout\n");
			expect(capture.stderr).toHaveLength(0);
		});

		it("leaves output from other async contexts visible while the window is open", async () => {
			installCursorSdkProcessOutputFilter();
			const gate = deferred();
			const creation = suppressCursorSdkOutput(async () => {
				await gate.promise;
				console.log("muted creation output");
				write("stdout", "muted creation output\n");
			});
			console.log("VISIBLE concurrent console");
			write("stdout", "VISIBLE concurrent stdout\n");
			gate.resolve();
			await creation;
			expect(capture.consoleCalls.map((call) => call.args)).toEqual([["VISIBLE concurrent console"]]);
			expect(writtenText(capture.stdout)).toBe("VISIBLE concurrent stdout\n");
		});

		it("ends the window when the operation returns, throws or rejects", async () => {
			installCursorSdkProcessOutputFilter();
			const gate = deferred();
			const detachedStates: Promise<boolean>[] = [];
			// A continuation created inside the window inherits its context; it observes the window state later.
			const observeLater = () => {
				detachedStates.push(gate.promise.then(() => isCursorSdkOutputSuppressed()));
			};
			expect(
				suppressCursorSdkOutput(() => {
					observeLater();
					return 7;
				}),
			).toBe(7);
			expect(() =>
				suppressCursorSdkOutput(() => {
					observeLater();
					throw new Error("sync failure");
				}),
			).toThrow("sync failure");
			await expect(
				suppressCursorSdkOutput(async () => {
					observeLater();
					throw new Error("async failure");
				}),
			).rejects.toThrow("async failure");
			gate.resolve();
			expect(await Promise.all(detachedStates)).toEqual([false, false, false]);
		});

		it("does not mute console outside the window, and still drops verified frames there", async () => {
			installCursorSdkProcessOutputFilter();
			await suppressCursorSdkOutput(async () => {
				console.log("muted");
			});
			for (const method of CONSOLE_METHODS) console[method](`VISIBLE ${method}`);
			console.log(PLAIN_INFO);
			console.warn(HOOK_NOTICE);
			expect(capture.consoleCalls.map((call) => [call.method, call.args[0]])).toEqual(
				CONSOLE_METHODS.map((method) => [method, `VISIBLE ${method}`]),
			);
		});
	});
});
