// Child process for test/cursor-session-store-legacy-root.test.ts, run by Bun with a throwaway HOME.
//
// `getDefaultSdkStateRoot` resolves `<HOME>/.cursor/projects/...` through `os.homedir()`, which Bun reads once at
// startup, so the test process cannot redirect it and the SDK has to run in a process that starts with the HOME it
// should see. Everything here is the installed @cursor/sdk for real (its state-root function and its rename of an
// MD5-derived root, SQLite stores, `Agent.resume`, `Agent.delete`) driven through the plugin's own store and cleanup
// modules. The 1.0.34 layout is reproduced from its source: `join(<project dir>, "sdk-agent-store", md5(workspaceRef))`
// with `createHash("md5").update(workspaceRef).digest("hex")`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Agent, getDefaultSdkStateRoot, type LocalAgentStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { runCursorSessionAgentCleanupCommand, __testUtils as cleanupTestUtils } from "../../src/cursor-session-agent-cleanup.js";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, resolveCursorSessionRepoRoot } from "../../src/cursor-session-agent-resume.js";
import { __testUtils as scopeTestUtils } from "../../src/cursor-session-scope.js";
import {
	buildCursorSessionStateRoot,
	deriveLegacyCursorSdkStateRoot,
	getCursorSessionStoreIdentities,
	hashCursorSessionStoreScope,
	openCursorSessionStoreForScope,
	type CursorSessionStoreSelection,
} from "../../src/cursor-session-store.js";

interface SelectionSummary {
	resumeAttemptAllowed: boolean;
	resumeFallback: boolean;
	stateRoot: string;
}

const SESSION_ID = "session-legacy-root";

function md5(value: string): string {
	return createHash("md5").update(value).digest("hex");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface Workspace {
	cwd: string;
	scopeKey: string;
	/** What 1.0.40 answers: `.../sdk-agent-store/sha256(cwd)`. */
	defaultRoot: string;
	/** What 1.0.34 answered: `.../sdk-agent-store/md5(cwd)`. */
	legacyRoot: string;
	legacySessionRoot: string;
	currentSessionRoot: string;
}

function newWorkspace(name: string): Workspace {
	const workspaces = join(homedir(), "workspaces");
	mkdirSync(workspaces, { recursive: true });
	const cwd = realpathSync(mkdtempSync(join(workspaces, `${name}-`)));
	const scopeKey = join(cwd, "session.jsonl");
	// Neither root exists yet, so this call renames nothing.
	const defaultRoot = getDefaultSdkStateRoot(cwd);
	const legacyRoot = join(dirname(defaultRoot), md5(cwd));
	return {
		cwd,
		scopeKey,
		defaultRoot,
		legacyRoot,
		legacySessionRoot: buildCursorSessionStateRoot(legacyRoot, scopeKey, true),
		currentSessionRoot: buildCursorSessionStateRoot(defaultRoot, scopeKey, true),
	};
}

async function withStore<T>(cwd: string, stateRoot: string, use: (store: SqliteLocalAgentStore) => Promise<T>): Promise<T> {
	const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot });
	try {
		return await use(store);
	} finally {
		await store.dispose();
	}
}

async function seed(cwd: string, stateRoot: string, agentIds: readonly string[]): Promise<void> {
	await withStore(cwd, stateRoot, async (store) => {
		for (const agentId of agentIds) {
			await store.agents.create({ agent: { agentId, cwd, status: "idle", createdAt: 1, updatedAt: 1 } });
		}
	});
}

function agentIds(cwd: string, stateRoot: string): Promise<string[]> {
	return withStore(cwd, stateRoot, async (store) =>
		(await store.agents.list({ filter: { cwd } })).items.map((agent) => agent.agentId).sort(),
	);
}

async function resumeProbe(cwd: string, store: LocalAgentStore, agentId: string): Promise<{ resumed?: string; error?: string }> {
	try {
		const agent = await Agent.resume(agentId, { local: { cwd, store } });
		const resumed = agent.agentId;
		await agent[Symbol.asyncDispose]();
		return { resumed };
	} catch (error) {
		return { error: `${(error as Error).name}: ${(error as Error).message}` };
	}
}

async function withSelection<T>(
	workspace: Workspace,
	recordedStateRoot: string,
	use: (selection: CursorSessionStoreSelection) => Promise<T>,
): Promise<T> {
	const selection = await openCursorSessionStoreForScope({
		cwd: workspace.cwd,
		scopeKey: workspace.scopeKey,
		persistent: true,
		hasResumeHandle: true,
		resumeIdentity: { version: 1, stateRoot: recordedStateRoot },
	});
	try {
		return await use(selection);
	} finally {
		await selection.sessionStore.dispose();
	}
}

function summarize(selection: CursorSessionStoreSelection): SelectionSummary {
	return {
		resumeAttemptAllowed: selection.resumeAttemptAllowed,
		resumeFallback: selection.resumeFallback,
		stateRoot: selection.sessionStore.identity.stateRoot,
	};
}

async function runCleanup(workspace: Workspace, candidates: readonly { agentId: string; stateRoot: string }[]) {
	cleanupTestUtils.reset();
	cleanupTestUtils.setAppendDurability(() => true);
	scopeTestUtils.set(workspace.cwd, workspace.scopeKey, SESSION_ID);
	const repoRoot = resolveCursorSessionRepoRoot(workspace.cwd);
	const createdAt = "2026-10-22T00:00:00.000Z";
	const entries = [{
		type: "custom",
		id: "resume-1",
		parentId: null,
		timestamp: createdAt,
		customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
		data: {
			version: 2,
			runtime: "local",
			agentId: "agent-active",
			scopeKey: workspace.scopeKey,
			sessionFile: workspace.scopeKey,
			sessionId: SESSION_ID,
			cwd: workspace.cwd,
			...(repoRoot ? { repoRoot } : {}),
			poolKey: "pool-1",
			branchPathHash: "hash",
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			createdAt,
			storeIdentity: { version: 1, stateRoot: workspace.currentSessionRoot },
			cleanupCandidates: candidates.map(({ agentId, stateRoot }) => ({ agentId, storeIdentity: { version: 1, stateRoot } })),
		},
	}];
	const appended: Array<{ phase?: string; deletedAgentIds?: string[]; failedAgentIds?: Array<{ agentId: string; retryable?: boolean }> }> = [];
	const notifications: string[] = [];
	await runCursorSessionAgentCleanupCommand(
		{ appendEntry: (_customType: string, data: (typeof appended)[number]) => appended.push(data) } as never,
		"--yes",
		{
			cwd: workspace.cwd,
			sessionManager: {
				getEntries: () => entries,
				getBranch: () => entries,
				getSessionFile: () => workspace.scopeKey,
				getSessionId: () => SESSION_ID,
			},
			ui: { notify: (message: string) => notifications.push(message) },
		} as never,
	);
	const result = appended.find((entry) => entry.phase === "result");
	return { deleted: result?.deletedAgentIds ?? [], failed: result?.failedAgentIds ?? [], notifications };
}

async function contractScenario() {
	const workspace = newWorkspace("contract");
	mkdirSync(workspace.legacyRoot, { recursive: true });
	writeFileSync(join(workspace.legacyRoot, "legacy-marker"), "legacy");
	const before = { legacyExists: existsSync(workspace.legacyRoot), defaultExists: existsSync(workspace.defaultRoot) };
	const first = getDefaultSdkStateRoot(workspace.cwd);
	const afterFirst = { legacyExists: existsSync(workspace.legacyRoot), defaultExists: existsSync(workspace.defaultRoot) };
	const second = getDefaultSdkStateRoot(workspace.cwd);
	return {
		defaultRootIsSha256: basename(workspace.defaultRoot) === sha256(workspace.cwd),
		derivedLegacyRoot: deriveLegacyCursorSdkStateRoot(workspace.defaultRoot, workspace.cwd) ?? null,
		legacyRoot: workspace.legacyRoot,
		before,
		first: first === workspace.defaultRoot,
		afterFirst,
		second: second === workspace.defaultRoot,
		markerMoved: existsSync(join(workspace.defaultRoot, "legacy-marker")),
		identitiesLegacyRoot: (await getCursorSessionStoreIdentities(workspace.cwd, workspace.scopeKey, true)).legacy?.defaultStore.stateRoot ?? null,
		fileless: (await getCursorSessionStoreIdentities(workspace.cwd, workspace.scopeKey, false)).legacy ?? null,
	};
}

async function resumeScenario() {
	const workspace = newWorkspace("resume");
	await seed(workspace.cwd, workspace.legacySessionRoot, ["agent-session"]);
	await seed(workspace.cwd, workspace.legacyRoot, ["agent-shared"]);
	writeFileSync(join(workspace.legacyRoot, "keep.txt"), "keep");

	// The plugin's first call also performs the SDK's first `getDefaultSdkStateRoot`, which renames the root.
	const session = await withSelection(workspace, workspace.legacySessionRoot, async (selection) => ({
		...summarize(selection),
		resume: await resumeProbe(workspace.cwd, selection.sessionStore.store, "agent-session"),
		// The plugin does not look the agent up itself: Agent.resume does, and rejects an agent the store does not hold.
		missing: await resumeProbe(workspace.cwd, selection.sessionStore.store, "agent-missing"),
	}));
	const afterRename = { legacyExists: existsSync(workspace.legacyRoot), defaultExists: existsSync(workspace.defaultRoot) };
	const defaultStore = await withSelection(workspace, workspace.legacyRoot, async (selection) => ({
		...summarize(selection),
		resume: await resumeProbe(workspace.cwd, selection.sessionStore.store, "agent-shared"),
	}));
	return { workspace, afterRename, session, default: defaultStore };
}

async function resumeDisposalScenario() {
	const workspace = newWorkspace("resume-disposal");
	await seed(workspace.cwd, workspace.legacySessionRoot, ["agent-session"]);
	writeFileSync(join(workspace.legacyRoot, "keep.txt"), "keep");
	await withSelection(workspace, workspace.legacySessionRoot, async () => undefined);
	return {
		defaultRootExists: existsSync(workspace.defaultRoot),
		sessionRootExists: existsSync(workspace.currentSessionRoot),
		keepMarkerExists: existsSync(join(workspace.defaultRoot, "keep.txt")),
		agents: await agentIds(workspace.cwd, workspace.currentSessionRoot),
	};
}

async function coexistingScenario() {
	const workspace = newWorkspace("coexisting");
	// Both roots exist before the SDK first looks: it returns the SHA-256 root and never touches the MD5 one.
	await seed(workspace.cwd, workspace.legacySessionRoot, ["agent-session", "agent-old"]);
	await seed(workspace.cwd, workspace.currentSessionRoot, ["agent-fresh", "agent-old"]);
	writeFileSync(join(workspace.legacyRoot, "legacy-marker"), "legacy");
	writeFileSync(join(workspace.defaultRoot, "current-marker"), "current");

	const { resume, ...selection } = await withSelection(workspace, workspace.legacySessionRoot, async (opened) => ({
		...summarize(opened),
		resume: await resumeProbe(workspace.cwd, opened.sessionStore.store, "agent-session"),
	}));
	const afterResume = {
		legacyExists: existsSync(workspace.legacyRoot),
		defaultExists: existsSync(workspace.defaultRoot),
		legacyMarker: existsSync(join(workspace.legacyRoot, "legacy-marker")),
		currentMarker: existsSync(join(workspace.defaultRoot, "current-marker")),
		legacyAgents: await agentIds(workspace.cwd, workspace.legacySessionRoot),
		currentAgents: await agentIds(workspace.cwd, workspace.currentSessionRoot),
	};
	const cleanup = await runCleanup(workspace, [{ agentId: "agent-old", stateRoot: workspace.legacySessionRoot }]);
	return {
		workspace,
		selection,
		resume,
		afterResume,
		cleanup,
		afterCleanup: {
			legacyExists: existsSync(workspace.legacyRoot),
			legacyAgents: await agentIds(workspace.cwd, workspace.legacySessionRoot),
			currentAgents: await agentIds(workspace.cwd, workspace.currentSessionRoot),
		},
	};
}

async function cleanupScenario() {
	const workspace = newWorkspace("cleanup");
	// `agent-old` is recorded for the session store, and an agent with the same id also sits in the shared default store.
	await seed(workspace.cwd, workspace.legacySessionRoot, ["agent-old", "agent-other"]);
	await seed(workspace.cwd, workspace.legacyRoot, ["agent-old", "agent-shared"]);
	writeFileSync(join(workspace.legacyRoot, "keep.txt"), "keep");

	const cleanup = await runCleanup(workspace, [{ agentId: "agent-old", stateRoot: workspace.legacySessionRoot }]);
	return {
		workspace,
		cleanup,
		after: {
			legacyExists: existsSync(workspace.legacyRoot),
			defaultExists: existsSync(workspace.defaultRoot),
			sessionRootExists: existsSync(workspace.currentSessionRoot),
			keepMarkerExists: existsSync(join(workspace.defaultRoot, "keep.txt")),
			sessionAgents: await agentIds(workspace.cwd, workspace.currentSessionRoot),
			sharedAgents: await agentIds(workspace.cwd, workspace.defaultRoot),
		},
	};
}

async function outsideScenario() {
	const workspace = newWorkspace("outside");
	await seed(workspace.cwd, workspace.legacySessionRoot, ["agent-session"]);
	const elsewhere = join(workspace.cwd, "elsewhere", "pi-sessions", hashCursorSessionStoreScope(workspace.scopeKey));
	const otherSession = join(workspace.legacyRoot, "pi-sessions", hashCursorSessionStoreScope("another-session"));
	const otherWorkspace = join(dirname(workspace.defaultRoot), md5(`${workspace.cwd}-other`));
	const outside = { elsewhere, otherSession, otherWorkspace };
	await seed(workspace.cwd, elsewhere, ["agent-old-elsewhere"]);
	await seed(workspace.cwd, otherSession, ["agent-old-other-session"]);
	await seed(workspace.cwd, otherWorkspace, ["agent-old-other-workspace"]);

	const resume: Record<string, SelectionSummary> = {};
	for (const [name, stateRoot] of Object.entries(outside)) {
		resume[name] = await withSelection(workspace, stateRoot, async (selection) => summarize(selection));
	}
	const cleanup = await runCleanup(workspace, [
		{ agentId: "agent-old-elsewhere", stateRoot: elsewhere },
		{ agentId: "agent-old-other-session", stateRoot: otherSession },
		{ agentId: "agent-old-other-workspace", stateRoot: otherWorkspace },
	]);
	return {
		workspace,
		resume,
		cleanup,
		after: {
			elsewhere: await agentIds(workspace.cwd, elsewhere),
			otherSession: await agentIds(workspace.cwd, join(workspace.defaultRoot, "pi-sessions", hashCursorSessionStoreScope("another-session"))),
			otherWorkspace: await agentIds(workspace.cwd, otherWorkspace),
		},
	};
}

/** A recorded store that is simply gone: the same outcome whether the identity is a legacy one or a current one. */
async function goneScenario() {
	const outcome = async (name: string, recordedStateRoot: (workspace: Workspace) => string) => {
		// The legacy root exists, so the SDK renames it; the session store inside it never existed.
		const gone = async (suffix: string) => {
			const workspace = newWorkspace(`${name}-${suffix}`);
			await seed(workspace.cwd, workspace.legacyRoot, ["agent-shared"]);
			return { workspace, stateRoot: recordedStateRoot(workspace) };
		};
		const resuming = await gone("resume");
		const selection = await withSelection(resuming.workspace, resuming.stateRoot, async (opened) => ({
			...summarize(opened),
			resume: await resumeProbe(resuming.workspace.cwd, opened.sessionStore.store, "agent-old"),
		}));
		const cleaning = await gone("cleanup");
		const cleanup = await runCleanup(cleaning.workspace, [{ agentId: "agent-old", stateRoot: cleaning.stateRoot }]);
		return { workspace: resuming.workspace, selection, cleanup };
	};
	return {
		legacy: await outcome("gone-legacy", (workspace) => workspace.legacySessionRoot),
		current: await outcome("gone-current", (workspace) => workspace.currentSessionRoot),
	};
}

/** The legacy root cannot be inspected (a symlink loop gives ELOOP): neither resume nor cleanup may treat that as absence. */
async function unreadableScenario() {
	if (process.platform === "win32") return null;
	const workspace = newWorkspace("unreadable");
	mkdirSync(dirname(workspace.legacyRoot), { recursive: true });
	symlinkSync(workspace.legacyRoot, workspace.legacyRoot);
	let selectionError: string | null = null;
	try {
		await withSelection(workspace, workspace.legacySessionRoot, async () => undefined);
	} catch (error) {
		selectionError = `${(error as NodeJS.ErrnoException).code}`;
	}
	const cleanup = await runCleanup(workspace, [{ agentId: "agent-old", stateRoot: workspace.legacySessionRoot }]);
	return { workspace, selectionError, cleanup, defaultRootCreated: existsSync(workspace.defaultRoot) };
}

const results = {
	contract: await contractScenario(),
	resume: await resumeScenario(),
	resumeDisposal: await resumeDisposalScenario(),
	coexisting: await coexistingScenario(),
	cleanup: await cleanupScenario(),
	outside: await outsideScenario(),
	gone: await goneScenario(),
	unreadable: await unreadableScenario(),
};
process.stdout.write(`\nRESULT:${JSON.stringify(results)}\n`, () => process.exit(0));
