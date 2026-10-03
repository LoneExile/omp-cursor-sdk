// Bun 1.3.14's Subprocess finalizer closes extra stdio fds (index >= 3) that
// it still marks as owned. The Cursor SDK shell passes two extra "pipe" slots
// for shell state. After the shell exits, those descriptors are closed and the
// kernel can reuse the numbers for SQLite. The finalizer then close()s them.
// On macOS that is EXC_GUARD (guard 0x08fd4dbfade2dead) and the omp process dies.
// Symbol.dispose runs the same close and dies the same way. Holding the
// Subprocess keeps the finalizer from running. Bun.spawn with only stdin,
// stdout, and stderr does not take this path.

const retainedSubprocesses = new Set<unknown>();
let installed = false;

interface BunSpawnHost {
	spawn: (options: unknown, ...rest: unknown[]) => unknown;
}

export function retainedCursorSpawnCount(): number {
	return retainedSubprocesses.size;
}

export function cursorExtraStdioNeedsRetain(stdio: unknown): boolean {
	if (!Array.isArray(stdio) || stdio.length <= 3) return false;
	return stdio.slice(3).some((slot) => slot === "pipe" || typeof slot === "number");
}

function isSpawnOptions(value: unknown): value is { stdio?: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stdioFromSpawnArgs(options: unknown, rest: readonly unknown[]): unknown {
	if (isSpawnOptions(options) && "stdio" in options) return options.stdio;
	const second = rest[0];
	if (isSpawnOptions(second) && "stdio" in second) return second.stdio;
	return undefined;
}

function bunSpawnHost(): BunSpawnHost | undefined {
	const host = (globalThis as { Bun?: BunSpawnHost }).Bun;
	if (!host || typeof host.spawn !== "function") return undefined;
	return host;
}

export function installCursorSpawnFdGuard(): void {
	if (installed) return;
	const host = bunSpawnHost();
	if (!host) return;
	installed = true;
	const original = host.spawn;
	host.spawn = function guardedSpawn(this: unknown, options: unknown, ...rest: unknown[]) {
		const proc = original.call(this, options, ...rest);
		if (cursorExtraStdioNeedsRetain(stdioFromSpawnArgs(options, rest))) retainedSubprocesses.add(proc);
		return proc;
	};
}

// First import of this module installs the guard before later plugin modules run.
installCursorSpawnFdGuard();
