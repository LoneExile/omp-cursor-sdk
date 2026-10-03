import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cursorExtraStdioNeedsRetain,
	installCursorSpawnFdGuard,
	retainedCursorSpawnCount,
} from "../src/cursor-spawn-fd-guard.js";

interface GuardedDatabase {
	exec(sql: string): void;
	close(): void;
}

// bun:sqlite is the same library that guards fds with 0x08fd4dbfade2dead.
// A non-literal import keeps tsc from requiring bun typings.
async function openGuardedDatabase(path: string): Promise<GuardedDatabase> {
	const specifier = "bun:" + "sqlite";
	const mod = (await import(specifier)) as {
		Database: new (filename: string) => GuardedDatabase;
	};
	return new mod.Database(path);
}

function collectGarbage(): void {
	const gc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc;
	gc?.(true);
}

describe("cursor extra stdio retain", () => {
	it("keeps only extra pipe and numeric descriptors", () => {
		expect(cursorExtraStdioNeedsRetain(["ignore", "pipe", "pipe"])).toBe(false);
		expect(cursorExtraStdioNeedsRetain("pipe")).toBe(false);
		expect(cursorExtraStdioNeedsRetain(["ignore", "pipe", "pipe", "ignore"])).toBe(false);
		expect(cursorExtraStdioNeedsRetain([null, "pipe", "pipe", "pipe", "pipe"])).toBe(true);
		expect(cursorExtraStdioNeedsRetain(["ignore", "pipe", "pipe", 7])).toBe(true);
	});

	it("survives garbage collection after extra-pipe shells exit", async () => {
		installCursorSpawnFdGuard();
		const before = retainedCursorSpawnCount();
		const spawnCount = 6;
		const children = [];
		for (let i = 0; i < spawnCount; i++) {
			const child = spawn("/bin/sh", ["-c", "echo ok"], {
				stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
			});
			child.stdout?.resume();
			child.stderr?.resume();
			for (const extra of child.stdio.slice(3)) {
				if (extra && "resume" in extra) extra.resume();
			}
			await new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", () => resolve());
			});
			children.push(child);
		}
		children.length = 0;

		const dir = mkdtempSync(join(tmpdir(), "cursor-spawn-fd-guard-"));
		const databases: GuardedDatabase[] = [];
		try {
			for (let i = 0; i < 24; i++) {
				const database = await openGuardedDatabase(join(dir, `${i}.sqlite`));
				database.exec("create table t (id integer)");
				databases.push(database);
			}
			collectGarbage();
			await new Promise((resolve) => setTimeout(resolve, 20));
			collectGarbage();
			expect(retainedCursorSpawnCount() - before).toBe(spawnCount);
		} finally {
			for (const database of databases) database.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
