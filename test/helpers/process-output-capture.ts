export type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
export const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

type ConsoleFn = (...args: unknown[]) => void;
type WriteFn = typeof process.stdout.write;

/** One call that reached a recorder, kept by reference so tests can prove nothing was copied or rewrapped. */
export interface RecordedWrite {
	chunk: unknown;
	encoding: unknown;
	callback: unknown;
	argCount: number;
	receiver: unknown;
}

export interface RecordedConsoleCall {
	method: ConsoleMethod;
	args: unknown[];
	receiver: unknown;
}

export interface ProcessOutputCapture {
	stdout: RecordedWrite[];
	stderr: RecordedWrite[];
	consoleCalls: RecordedConsoleCall[];
	/** The recorder functions: what process.stdout.write etc. must be again once every filter lease is released. */
	recorders: {
		stdoutWrite: WriteFn;
		stderrWrite: WriteFn;
		console: Record<ConsoleMethod, ConsoleFn>;
	};
	clear(): void;
	restore(): void;
}

/**
 * Replaces process.stdout/stderr.write and console.* with recorders. Install it BEFORE the filter under test
 * (the filter wraps the recorder, like it wraps the real streams) and restore it after the filter is released.
 * `writeResult` is what the recorders return, so tests can tell a forwarded write (this value) from a
 * dropped frame (always `true`).
 */
export function captureProcessOutput(options: { writeResult?: boolean } = {}): ProcessOutputCapture {
	const writeResult = options.writeResult ?? true;
	const stdout: RecordedWrite[] = [];
	const stderr: RecordedWrite[] = [];
	const consoleCalls: RecordedConsoleCall[] = [];
	const originals = {
		stdoutWrite: process.stdout.write,
		stderrWrite: process.stderr.write,
		console: Object.fromEntries(CONSOLE_METHODS.map((method) => [method, console[method]])) as Record<ConsoleMethod, ConsoleFn>,
	};

	const recordWrites = (into: RecordedWrite[]) =>
		function (this: unknown, chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
			into.push({ chunk, encoding, callback, argCount: arguments.length, receiver: this });
			return writeResult;
		};
	const recorders = {
		stdoutWrite: recordWrites(stdout) as unknown as WriteFn,
		stderrWrite: recordWrites(stderr) as unknown as WriteFn,
		console: Object.fromEntries(
			CONSOLE_METHODS.map((method) => [
				method,
				function (this: unknown, ...args: unknown[]): void {
					consoleCalls.push({ method, args, receiver: this });
				},
			]),
		) as Record<ConsoleMethod, ConsoleFn>,
	};
	process.stdout.write = recorders.stdoutWrite;
	process.stderr.write = recorders.stderrWrite;
	for (const method of CONSOLE_METHODS) console[method] = recorders.console[method];

	return {
		stdout,
		stderr,
		consoleCalls,
		recorders,
		clear() {
			stdout.length = 0;
			stderr.length = 0;
			consoleCalls.length = 0;
		},
		restore() {
			process.stdout.write = originals.stdoutWrite;
			process.stderr.write = originals.stderrWrite;
			for (const method of CONSOLE_METHODS) console[method] = originals.console[method];
		},
	};
}

/** Concatenated text of the recorded writes (string chunks as-is, binary chunks decoded as UTF-8). */
export function writtenText(writes: readonly RecordedWrite[]): string {
	return writes
		.map(({ chunk }) =>
			typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
		)
		.join("");
}
