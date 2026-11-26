import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, createAgentPlatform, type LocalAgentStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { describe, expect, it, vi } from "vitest";
import {
	buildCursorSessionStateRoot,
	hashCursorSessionStoreScope,
	openCursorSessionStore,
	openCursorSessionStoreForScope,
	__testUtils as storeTestUtils,
} from "../src/cursor-session-store.js";

describe("cursor session store identity", () => {
	it("derives a stable session root below the SDK workspace state root", () => {
		const scopeKey = "/tmp/sessions/example.jsonl";
		expect(hashCursorSessionStoreScope(scopeKey)).toBe("9983782212ce97faa33c17445f21670d");
		expect(buildCursorSessionStateRoot("/sdk/workspace", scopeKey, true)).toBe(
			join("/sdk/workspace", "pi-sessions", "9983782212ce97faa33c17445f21670d"),
		);
	});

	it("separates persisted pi sessions and gives every fileless open a temporary root", () => {
		const first = buildCursorSessionStateRoot("/sdk/workspace", "session-a", true);
		const second = buildCursorSessionStateRoot("/sdk/workspace", "session-b", true);
		const anonymous = buildCursorSessionStateRoot("/sdk/workspace", "__anonymous__", false);

		expect(first).not.toBe(second);
		expect(anonymous).not.toBe(buildCursorSessionStateRoot("/sdk/workspace", "__anonymous__", false));
		expect(anonymous).toContain(join(tmpdir(), "pi-cursor-sdk-"));
		expect(anonymous).toContain("pi-sessions");
	});

	it("never resumes a fileless acquisition from the shared default store", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-fileless-shared-store-"));
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => workspaceRoot,
			openSqliteStore: async () => ({
				dispose: async () => {},
			}) as unknown as LocalAgentStore & { dispose(): Promise<void> },
		});
		try {
			const selection = await openCursorSessionStoreForScope({
				cwd: workspaceRoot,
				scopeKey: "ephemeral",
				persistent: false,
				hasResumeHandle: true,
				resumeIdentity: { version: 1, stateRoot: workspaceRoot },
			});
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.sessionStore.identity.stateRoot).not.toBe(workspaceRoot);
			await selection.sessionStore.dispose();
		} finally {
			storeTestUtils.setSdkOperations(undefined);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("removes a factory-owned temporary store after graceful disposal", async () => {
		storeTestUtils.setSdkOperations(undefined);
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-ephemeral-store-"));
		const selection = await openCursorSessionStoreForScope({
			cwd: root,
			scopeKey: "ephemeral",
			persistent: false,
			hasResumeHandle: false,
		});
		const removalRoot = dirname(dirname(selection.sessionStore.identity.stateRoot));
		expect(existsSync(selection.sessionStore.identity.stateRoot)).toBe(true);

		await selection.sessionStore.dispose();

		expect(existsSync(removalRoot)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	it("never grants temporary-removal ownership to a caller-supplied store", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-shared-store-"));
		const sharedRoot = join(workspaceRoot, "shared");
		const marker = join(sharedRoot, "keep.txt");
		mkdirSync(sharedRoot, { recursive: true });
		writeFileSync(marker, "keep");
		const selection = await openCursorSessionStoreForScope({
			cwd: workspaceRoot,
			scopeKey: "persisted-session",
			persistent: true,
			hasResumeHandle: true,
			resumeIdentity: { version: 1, stateRoot: sharedRoot },
		});
		try {
			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(selection.resumeFallback).toBe(true);
			expect(selection.sessionStore.identity.stateRoot).not.toBe(sharedRoot);
		} finally {
			await selection.sessionStore.dispose();
			expect(existsSync(marker)).toBe(true);
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it.each(["succeeds", "fails"] as const)("shares one installed SQLite close outcome with concurrent and later callers and removes the temporary root when disposal %s", async (outcome) => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cursor-store-dispose-"));
		const close = SqliteLocalAgentStore.prototype.dispose;
		const sdkDispose = vi.spyOn(SqliteLocalAgentStore.prototype, "dispose");
		// A reported close failure must stay failed: repeating the installed dispose() finds nothing open and resolves.
		if (outcome === "fails") sdkDispose.mockImplementationOnce(async function (this: SqliteLocalAgentStore) {
			await close.call(this);
			throw new Error("dispose failed");
		});
		const settles = (disposal: Promise<void>) => outcome === "fails"
			? expect(disposal).rejects.toThrow("dispose failed")
			: expect(disposal).resolves.toBeUndefined();
		try {
			const { sessionStore } = await openCursorSessionStoreForScope({ cwd: workspaceRoot, scopeKey: "ephemeral", persistent: false, hasResumeHandle: false });
			const removalRoot = dirname(dirname(sessionStore.identity.stateRoot));
			expect(existsSync(join(sessionStore.identity.stateRoot, "index.db"))).toBe(true);
			const [first, overlapping] = [sessionStore.dispose(), sessionStore.dispose()];
			await settles(overlapping);
			expect(existsSync(removalRoot)).toBe(false);
			await settles(first);
			await settles(sessionStore.dispose());
			expect(sdkDispose).toHaveBeenCalledTimes(1);
		} finally {
			sdkDispose.mockRestore();
			rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	it("opens isolated SQLite stores that can write concurrently", async () => {
		storeTestUtils.setSdkOperations(undefined);
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-session-stores-"));
		const [first, second] = await Promise.all([
			openCursorSessionStore(root, { version: 1, stateRoot: join(root, "first") }),
			openCursorSessionStore(root, { version: 1, stateRoot: join(root, "second") }),
		]);
		try {
			await Promise.all([
				first.store.agents.create({ agent: {
					agentId: "agent-first",
					cwd: root,
					status: "idle",
					createdAt: 1,
					updatedAt: 1,
				} }),
				second.store.agents.create({ agent: {
					agentId: "agent-second",
					cwd: root,
					status: "idle",
					createdAt: 1,
					updatedAt: 1,
				} }),
			]);
			expect(await first.store.agents.get({ agentId: "agent-first" })).toMatchObject({ agentId: "agent-first" });
			expect(await first.store.agents.get({ agentId: "agent-second" })).toBeNull();
			expect(await Agent.messages.list("agent-first", { runtime: "local", cwd: root, store: first.store })).toEqual([]);
			const platform = await createAgentPlatform({
				localStore: second.store,
				workspaceRef: root,
				scopedWorkspaceRef: root,
			});
			expect(await platform.getAgent("agent-second")).toMatchObject({ agentId: "agent-second" });
			await Agent.delete("agent-first", { cwd: root, store: first.store });
			expect(await first.store.agents.get({ agentId: "agent-first" })).toBeNull();
			expect(await second.store.agents.get({ agentId: "agent-second" })).toMatchObject({ agentId: "agent-second" });
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
