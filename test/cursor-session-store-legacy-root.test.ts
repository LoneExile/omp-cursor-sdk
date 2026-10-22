import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAgentStore } from "@cursor/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	admitRecordedCursorSessionStoreIdentity,
	buildCursorSessionStateRoot,
	deriveLegacyCursorSdkStateRoot,
	getCursorSessionStoreIdentities,
	openCursorSessionStoreForScope,
	__testUtils as storeTestUtils,
	type CursorSessionStoreIdentity,
} from "../src/cursor-session-store.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { acquireSessionCursorAgent, __testUtils as sessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as scopeTestUtils } from "../src/cursor-session-scope.js";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";

// @cursor/sdk 1.0.35 changed the default state root from `.../sdk-agent-store/md5(workspaceRef)` to `.../sha256(...)`
// and `getDefaultSdkStateRoot` renames an existing MD5 directory into place. The plugin keeps per-session stores
// inside that root and records their absolute paths, so identities recorded before the upgrade name MD5 paths.
//
// 1.0.34 source (`dist/esm/index.js` module `./src/agent/store/sdk-state-root.ts`, same in cjs and bundled):
//   const r = createHash("md5").update(t).digest("hex");
//   return join(Rv(homedir(), t), "sdk-agent-store", r);
// 1.0.40 (same module): `join(Rv(homedir(), t), "sdk-agent-store")` is the base, `sha256(t)` hex the root; an existing
// root is returned as is; otherwise an existing `md5(t)` directory is renamed to it (`renameSync`) and a failed rename
// that leaves the MD5 directory returns the MD5 path.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const childScript = join(repoRoot, "test", "helpers", "cursor-legacy-state-root-child.ts");

const tempRoots: string[] = [];

afterEach(() => storeTestUtils.setSdkOperations(undefined));
afterAll(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function md5(value: string): string {
	return createHash("md5").update(value).digest("hex");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

interface SelectionResult {
	resumeAttemptAllowed: boolean;
	resumeFallback: boolean;
	stateRoot: string;
}

interface ResumeProbe {
	resumed?: string;
	error?: string;
}

interface CleanupResult {
	deleted: string[];
	failed: Array<{ agentId: string; error: string; retryable?: boolean }>;
	notifications: string[];
}

interface ChildWorkspace {
	cwd: string;
	defaultRoot: string;
	legacyRoot: string;
	legacySessionRoot: string;
	currentSessionRoot: string;
}

interface RootsExist {
	legacyExists: boolean;
	defaultExists: boolean;
}

interface ChildResults {
	contract: {
		defaultRootIsSha256: boolean;
		derivedLegacyRoot: string | null;
		legacyRoot: string;
		before: RootsExist;
		first: boolean;
		afterFirst: RootsExist;
		second: boolean;
		markerMoved: boolean;
		identitiesLegacyRoot: string | null;
		fileless: unknown;
	};
	resume: {
		workspace: ChildWorkspace;
		afterRename: RootsExist;
		session: SelectionResult & { resume: ResumeProbe; missing: ResumeProbe };
		default: SelectionResult & { resume: ResumeProbe };
	};
	resumeDisposal: { defaultRootExists: boolean; sessionRootExists: boolean; keepMarkerExists: boolean; agents: string[] };
	coexisting: {
		workspace: ChildWorkspace;
		selection: SelectionResult;
		resume: ResumeProbe;
		afterResume: RootsExist & { legacyMarker: boolean; currentMarker: boolean; legacyAgents: string[]; currentAgents: string[] };
		cleanup: CleanupResult;
		afterCleanup: { legacyExists: boolean; legacyAgents: string[]; currentAgents: string[] };
	};
	cleanup: {
		workspace: ChildWorkspace;
		cleanup: CleanupResult;
		after: RootsExist & {
			sessionRootExists: boolean;
			keepMarkerExists: boolean;
			sessionAgents: string[];
			sharedAgents: string[];
		};
	};
	outside: {
		workspace: ChildWorkspace;
		resume: Record<"elsewhere" | "otherSession" | "otherWorkspace", SelectionResult>;
		cleanup: CleanupResult;
		after: Record<"elsewhere" | "otherSession" | "otherWorkspace", string[]>;
	};
	gone: Record<"legacy" | "current", {
		workspace: ChildWorkspace;
		selection: SelectionResult & { resume: ResumeProbe };
		cleanup: CleanupResult;
	}>;
	unreadable: { workspace: ChildWorkspace; selectionError: string | null; cleanup: CleanupResult; defaultRootCreated: boolean } | null;
}

// The child blocks in spawnSync and loads the SDK several times over, so every test that reads its result needs a
// per-test timeout above Bun's 5s default.
const CHILD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;

let childRun: { results: ChildResults } | { error: unknown } | undefined;

/**
 * Runs every real-SDK scenario once in a Bun child whose HOME is a throwaway directory. `getDefaultSdkStateRoot` reads
 * `os.homedir()`, which Bun resolves at startup, so an in-process test cannot point the SDK away from the real home.
 */
function childResults(): ChildResults {
	if (!childRun) {
		try {
			const home = join(makeTempRoot("omp-cursor-sdk-legacy-state-root-"), "home");
			mkdirSync(join(home, "agent"), { recursive: true });
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: join(home, "agent"),
			};
			delete env.CURSOR_API_KEY;
			const result = spawnSync(process.execPath, [childScript], {
				cwd: repoRoot,
				env,
				encoding: "utf8",
				timeout: CHILD_TIMEOUT_MS,
			});
			if (result.status !== 0) throw new Error(`Child exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
			const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
			if (!line) throw new Error(`The child printed no result:\n${result.stdout}\n${result.stderr}`);
			childRun = { results: JSON.parse(line.slice("RESULT:".length)) as ChildResults };
		} catch (error) {
			childRun = { error };
		}
	}
	if ("error" in childRun) throw childRun.error;
	return childRun.results;
}

describe("installed @cursor/sdk state-root migration (contract)", () => {
	it("answers with the SHA-256 root, and renames an MD5 root derived from the workspace into it on first call", () => {
		const { contract } = childResults();

		expect(contract.defaultRootIsSha256).toBe(true);
		// `legacyRoot` is computed in the child straight from the 1.0.34 formula, md5 hex of the workspace string beside the SHA-256 root.
		expect(contract.before).toEqual({ legacyExists: true, defaultExists: false });
		expect(contract.first).toBe(true);
		expect(contract.afterFirst).toEqual({ legacyExists: false, defaultExists: true });
		expect(contract.markerMoved).toBe(true);
		expect(contract.second).toBe(true);
		expect(contract.derivedLegacyRoot).toBe(contract.legacyRoot);
		expect(contract.identitiesLegacyRoot).toBe(contract.legacyRoot);
		expect(contract.fileless).toBeNull();
	}, TEST_TIMEOUT_MS);

	it("leaves verifying the recorded agent to the SDK: Agent.resume on the migrated store rejects an agent it does not hold", () => {
		// The plugin adds no agent lookup of its own. The SDK's `resumeAgent` reads the agent from the store it was given
		// and throws a non-retryable AgentNotFoundError, which createSessionAgentEntry turns into a fresh agent plus the
		// resume-fallback notice (see "falls back to a fresh agent" below).
		const { resume } = childResults();

		expect(resume.session.resume).toEqual({ resumed: "agent-session" });
		expect(resume.session.missing.error).toMatch(/^AgentNotFoundError: Agent agent-missing not found$/);
	}, TEST_TIMEOUT_MS);

	const sdkRoot = resolveInstalledPackageRoot("@cursor/sdk");
	const stateRootBuilds = ["esm", "cjs", "bundled"].flatMap((build) =>
		["index.js", "sqlite.js"].map((entry) => join("dist", build, entry)),
	);

	// The Bun runtime loads dist/bundled/*.js (exports["."].bun); the real-SDK child above exercises exactly that.
	// The Node builds cannot run under Bun, so their copy of the derivation is pinned by shape. The patterns use
	// no minified identifiers: only the digest names, the calls and the filesystem functions the migration needs.
	it.each(stateRootBuilds)("%s derives the SHA-256 root first and migrates an MD5 root with existsSync/renameSync", (file) => {
		const source = readFileSync(join(sdkRoot, file), "utf8");
		const at = source.indexOf('"sdk-agent-store"');
		expect(at, `${file} names the state root directory`).toBeGreaterThanOrEqual(0);
		expect(source.indexOf('"sdk-agent-store"', at + 1), `${file} has one copy of the derivation`).toBe(-1);
		const derivation = source.slice(Math.max(0, at - 400), at + 900);

		const sha = /\("sha256"\)\.update\([\w$]+\)\.digest\("hex"\)/.exec(derivation);
		const legacy = /\("md5"\)\.update\([\w$]+\)\.digest\("hex"\)/.exec(derivation);
		expect(sha, `${file} hashes the workspace with sha256`).not.toBeNull();
		expect(legacy, `${file} still knows the md5 root`).not.toBeNull();
		expect(sha!.index, "the SHA-256 root is derived before the MD5 one").toBeLessThan(legacy!.index);
		expect(derivation).toMatch(/\bexistsSync\b/);
		expect(derivation).toMatch(/\brenameSync\b/);
	});
});

describe("resume of an identity recorded under the legacy MD5 root", () => {
	it("resumes a session store after the SDK renamed the root", () => {
		const { resume } = childResults();

		expect(resume.afterRename).toEqual({ legacyExists: false, defaultExists: true });
		expect(resume.session).toMatchObject({
			resumeAttemptAllowed: true,
			resumeFallback: false,
			stateRoot: resume.workspace.currentSessionRoot,
		});
		expect(resume.session.stateRoot).not.toBe(resume.workspace.legacySessionRoot);
		expect(resume.session.resume).toEqual({ resumed: "agent-session" });
	}, TEST_TIMEOUT_MS);

	it("maps a recorded legacy default store onto the current default store", () => {
		const { resume } = childResults();

		expect(resume.default).toMatchObject({
			resumeAttemptAllowed: true,
			resumeFallback: false,
			stateRoot: resume.workspace.defaultRoot,
			resume: { resumed: "agent-shared" },
		});
	}, TEST_TIMEOUT_MS);

	it("never removes the shared workspace root when the resumed store is disposed", () => {
		const { resumeDisposal } = childResults();

		expect(resumeDisposal).toEqual({
			defaultRootExists: true,
			sessionRootExists: true,
			keepMarkerExists: true,
			agents: ["agent-session"],
		});
	}, TEST_TIMEOUT_MS);

	// A legacy identity whose mapped store is gone is covered with the current-identity case in "a recorded store that is gone".
});

describe("cleanup of an identity recorded under the legacy MD5 root", () => {
	it("deletes the agent from the mapped session store only", () => {
		const { cleanup } = childResults();

		expect(cleanup.cleanup).toEqual({
			deleted: ["agent-old"],
			failed: [],
			notifications: ["Deleted 1 recorded local Cursor SDK agent(s)."],
		});
		// The same id also lives in the shared default store, which stays untouched along with its root.
		expect(cleanup.after).toEqual({
			legacyExists: false,
			defaultExists: true,
			sessionRootExists: true,
			keepMarkerExists: true,
			sessionAgents: ["agent-other"],
			sharedAgents: ["agent-old", "agent-shared"],
		});
	}, TEST_TIMEOUT_MS);
});

describe("both the legacy and the SHA-256 roots exist", () => {
	it("keeps the recorded legacy store usable where it is and merges nothing", () => {
		const { coexisting } = childResults();

		expect(coexisting.selection).toEqual({
			resumeAttemptAllowed: true,
			resumeFallback: false,
			stateRoot: coexisting.workspace.legacySessionRoot,
		});
		expect(coexisting.resume).toEqual({ resumed: "agent-session" });
		expect(coexisting.afterResume).toEqual({
			legacyExists: true,
			defaultExists: true,
			legacyMarker: true,
			currentMarker: true,
			legacyAgents: ["agent-old", "agent-session"],
			currentAgents: ["agent-fresh", "agent-old"],
		});
	}, TEST_TIMEOUT_MS);

	it("cleans the recorded legacy session store, not the current one with the same agent id", () => {
		const { coexisting } = childResults();

		expect(coexisting.cleanup).toMatchObject({ deleted: ["agent-old"], failed: [] });
		expect(coexisting.afterCleanup).toEqual({
			legacyExists: true,
			legacyAgents: ["agent-session"],
			currentAgents: ["agent-fresh", "agent-old"],
		});
	}, TEST_TIMEOUT_MS);
});

describe("an identity outside this session's stores", () => {
	it("is not resumed and falls back to this session's current store", () => {
		const { outside } = childResults();

		for (const selection of Object.values(outside.resume)) {
			expect(selection).toEqual({
				resumeAttemptAllowed: false,
				resumeFallback: true,
				stateRoot: outside.workspace.currentSessionRoot,
			});
		}
	}, TEST_TIMEOUT_MS);

	it("is rejected by cleanup as non-retryable and nothing is deleted", () => {
		const { outside } = childResults();

		expect(outside.cleanup.deleted).toEqual([]);
		expect(outside.cleanup.failed).toEqual([
			{ agentId: "agent-old-elsewhere", error: expect.stringContaining("not valid for this pi session"), retryable: false },
			{ agentId: "agent-old-other-session", error: expect.stringContaining("not valid for this pi session"), retryable: false },
			{ agentId: "agent-old-other-workspace", error: expect.stringContaining("not valid for this pi session"), retryable: false },
		]);
		expect(outside.after).toEqual({
			elsewhere: ["agent-old-elsewhere"],
			otherSession: ["agent-old-other-session"],
			otherWorkspace: ["agent-old-other-workspace"],
		});
	}, TEST_TIMEOUT_MS);
});

describe("a recorded store that is gone", () => {
	it("is resumed at the mapped location for a legacy identity exactly as for a current one", () => {
		const { gone } = childResults();

		for (const outcome of [gone.legacy, gone.current]) {
			expect(outcome.selection).toEqual({
				resumeAttemptAllowed: true,
				resumeFallback: false,
				stateRoot: outcome.workspace.currentSessionRoot,
				// What createSessionAgentEntry catches to start a fresh agent.
				resume: { error: expect.stringMatching(/ not found$/) },
			});
		}
		expect(gone.legacy.selection.resume).toEqual(gone.current.selection.resume);
	}, TEST_TIMEOUT_MS);

	it("fails cleanup retryably for a legacy identity exactly as for a current one", () => {
		const { gone } = childResults();

		// Not a success and not a permanent rejection: the SDK reports the agent as not found, and cleanup keeps it retryable.
		for (const outcome of [gone.legacy, gone.current]) {
			expect(outcome.cleanup.deleted).toEqual([]);
			expect(outcome.cleanup.failed).toEqual([{ agentId: "agent-old", error: "Agent agent-old not found" }]);
		}
	}, TEST_TIMEOUT_MS);
});

describe("a legacy root that cannot be inspected", () => {
	it.skipIf(process.platform === "win32")("fails resume and cleanup retryably instead of rejecting the identity", () => {
		const { unreadable } = childResults();

		expect(unreadable).not.toBeNull();
		expect(unreadable!.selectionError).toBe("ELOOP");
		expect(unreadable!.cleanup.deleted).toEqual([]);
		// No `retryable: false`, and not the invalid-identity message.
		expect(unreadable!.cleanup.failed).toEqual([{ agentId: "agent-old", error: expect.any(String) }]);
		expect(unreadable!.cleanup.failed[0]!.error).not.toContain("not valid for this pi session");
		expect(unreadable!.defaultRootCreated).toBe(false);
	}, TEST_TIMEOUT_MS);
});

describe("legacy root admission rules", () => {
	const cwd = "/workspace/example";
	const scopeKey = "/sessions/example.jsonl";

	interface Layout {
		defaultRoot: string;
		legacyRoot: string;
		legacySessionRoot: string;
		currentSessionRoot: string;
	}

	/** SDK-shaped roots below a temp `sdk-agent-store`, with nothing created on disk. */
	function layout(): Layout {
		const base = join(makeTempRoot("omp-cursor-sdk-legacy-admission-"), "sdk-agent-store");
		const defaultRoot = join(base, sha256(cwd));
		const legacyRoot = join(base, md5(cwd));
		return {
			defaultRoot,
			legacyRoot,
			legacySessionRoot: buildCursorSessionStateRoot(legacyRoot, scopeKey, true),
			currentSessionRoot: buildCursorSessionStateRoot(defaultRoot, scopeKey, true),
		};
	}

	function identity(stateRoot: string): CursorSessionStoreIdentity {
		return { version: 1, stateRoot };
	}

	async function identitiesFor(roots: Layout, persistent = true) {
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => roots.defaultRoot,
			openSqliteStore: async () => { throw new Error("admission must not open a store"); },
		});
		return getCursorSessionStoreIdentities(cwd, scopeKey, persistent);
	}

	const both = ["defaultStore", "sessionStore"] as const;

	describe("deriveLegacyCursorSdkStateRoot", () => {
		it("is the MD5-named sibling of the SHA-256 root", () => {
			const roots = layout();
			expect(deriveLegacyCursorSdkStateRoot(roots.defaultRoot, cwd)).toBe(roots.legacyRoot);
		});

		it.each([
			["a custom root", () => "/tmp/cursor-sdk-state"],
			["the SHA-256 root of another workspace", (roots: Layout) => join(dirname(roots.defaultRoot), sha256("/workspace/other"))],
			["the MD5 root the SDK answers when its rename failed", (roots: Layout) => roots.legacyRoot],
		])("is undefined for %s", (_name, defaultRoot) => {
			const roots = layout();
			expect(deriveLegacyCursorSdkStateRoot(defaultRoot(roots), cwd)).toBeUndefined();
		});
	});

	describe("getCursorSessionStoreIdentities", () => {
		it("names the legacy stores of a persisted session only", async () => {
			const roots = layout();

			expect((await identitiesFor(roots)).legacy).toEqual({
				defaultStore: identity(roots.legacyRoot),
				sessionStore: identity(roots.legacySessionRoot),
			});
			expect((await identitiesFor(roots, false)).legacy).toBeUndefined();
		});

		it("names no legacy store when the SDK answered with the MD5 root", async () => {
			const roots = layout();
			const identities = await identitiesFor({ ...roots, defaultRoot: roots.legacyRoot });

			expect(identities.legacy).toBeUndefined();
			// The recorded identity is then the current one, and needs no mapping.
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both))
				.toEqual(identity(roots.legacySessionRoot));
		});
	});

	describe("admitRecordedCursorSessionStoreIdentity", () => {
		it("admits a current store without touching the filesystem", async () => {
			const roots = layout();
			const identities = await identitiesFor(roots);

			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.currentSessionRoot), identities, both))
				.toEqual(identity(roots.currentSessionRoot));
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.defaultRoot), identities, both))
				.toEqual(identity(roots.defaultRoot));
		});

		it("maps legacy stores onto the current ones once the legacy root is gone", async () => {
			const roots = layout();
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const identities = await identitiesFor(roots);

			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both))
				.toEqual(identity(roots.currentSessionRoot));
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacyRoot), identities, both))
				.toEqual(identity(roots.defaultRoot));
		});

		it("maps a legacy identity whose mapped store is gone like a current identity whose store is gone", async () => {
			const roots = layout();
			mkdirSync(roots.defaultRoot, { recursive: true });
			const identities = await identitiesFor(roots);

			const mapped = await admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both);
			const current = await admitRecordedCursorSessionStoreIdentity(identity(roots.currentSessionRoot), identities, both);

			expect(mapped).toEqual(identity(roots.currentSessionRoot));
			expect(current).toEqual(mapped);
			// Admission only decides which store to open: it creates nothing.
			expect(existsSync(roots.currentSessionRoot)).toBe(false);
		});

		it("keeps the recorded legacy store when both roots exist, and not the current store", async () => {
			const roots = layout();
			mkdirSync(roots.legacySessionRoot, { recursive: true });
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const identities = await identitiesFor(roots);

			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both))
				.toEqual(identity(roots.legacySessionRoot));
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacyRoot), identities, both))
				.toEqual(identity(roots.legacyRoot));
		});

		it("keeps a recorded legacy store as recorded while the legacy root exists, even if that store is gone", async () => {
			const roots = layout();
			mkdirSync(roots.legacyRoot, { recursive: true });
			mkdirSync(roots.defaultRoot, { recursive: true });
			const identities = await identitiesFor(roots);

			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both))
				.toEqual(identity(roots.legacySessionRoot));
			expect(existsSync(roots.legacySessionRoot)).toBe(false);
		});

		it("admits only the kinds the caller allows", async () => {
			const roots = layout();
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const identities = await identitiesFor(roots);

			// A fileless acquisition resumes from its own session store, never from the shared default store.
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacyRoot), identities, ["sessionStore"])).toBeUndefined();
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.defaultRoot), identities, ["sessionStore"])).toBeUndefined();
		});

		it("treats ENOTDIR as the legacy root being gone", async () => {
			const roots = layout();
			// `sdk-agent-store` is a file, so the legacy root below it cannot exist: access() fails with ENOTDIR.
			mkdirSync(dirname(roots.legacyRoot), { recursive: true });
			rmSync(dirname(roots.legacyRoot), { recursive: true });
			writeFileSync(dirname(roots.legacyRoot), "not a directory");
			const identities = await identitiesFor(roots);

			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both))
				.toEqual(identity(roots.currentSessionRoot));
		});

		it.skipIf(process.platform === "win32")("propagates an inspection failure other than absence", async () => {
			const roots = layout();
			// A symlink to itself makes access() fail with ELOOP: nothing says whether the legacy root exists.
			mkdirSync(dirname(roots.legacyRoot), { recursive: true });
			symlinkSync(roots.legacyRoot, roots.legacyRoot);
			const identities = await identitiesFor(roots);

			await expect(admitRecordedCursorSessionStoreIdentity(identity(roots.legacySessionRoot), identities, both))
				.rejects.toMatchObject({ code: "ELOOP" });
			// A current identity needs no inspection, so it is unaffected.
			expect(await admitRecordedCursorSessionStoreIdentity(identity(roots.currentSessionRoot), identities, both))
				.toEqual(identity(roots.currentSessionRoot));
		});

		it.each([
			["another session's store under the legacy root", (roots: Layout) => join(roots.legacyRoot, "pi-sessions", "0".repeat(32))],
			["a path below the legacy session store", (roots: Layout) => join(roots.legacySessionRoot, "nested")],
			["the legacy root of another workspace", (roots: Layout) => join(dirname(roots.legacyRoot), md5("/workspace/other"))],
			["an unrelated directory", () => "/tmp/untrusted-store"],
		])("rejects %s even when both roots exist", async (_name, recorded) => {
			const roots = layout();
			mkdirSync(roots.legacySessionRoot, { recursive: true });
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const stateRoot = recorded(roots);
			mkdirSync(stateRoot, { recursive: true });
			const identities = await identitiesFor(roots);

			expect(await admitRecordedCursorSessionStoreIdentity(identity(stateRoot), identities, both)).toBeUndefined();
		});
	});

	describe("openCursorSessionStoreForScope", () => {
		interface OpenRecord {
			opened: Array<{ workspaceRef: string; stateRoot: string }>;
			disposed: string[];
			stores: LocalAgentStore[];
		}

		/** Stubs that record what is opened and disposed. Nothing touches the filesystem. */
		function recordOpens(roots: Layout): OpenRecord {
			const record: OpenRecord = { opened: [], disposed: [], stores: [] };
			storeTestUtils.setSdkOperations({
				getDefaultStateRoot: () => roots.defaultRoot,
				openSqliteStore: async (options) => {
					record.opened.push(options);
					const store = { dispose: async () => { record.disposed.push(options.stateRoot); } } as unknown as LocalAgentStore & {
						dispose(): Promise<void>;
					};
					record.stores.push(store);
					return store;
				},
			});
			return record;
		}

		function resumeFrom(recorded: string, persistent = true) {
			return openCursorSessionStoreForScope({
				cwd,
				scopeKey,
				persistent,
				hasResumeHandle: true,
				resumeIdentity: identity(recorded),
			});
		}

		it("opens exactly the mapped store once the SDK moved the legacy root, and never the legacy path", async () => {
			const roots = layout();
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const record = recordOpens(roots);

			const selection = await resumeFrom(roots.legacySessionRoot);
			await selection.sessionStore.dispose();

			expect(selection).toMatchObject({ resumeAttemptAllowed: true, resumeFallback: false });
			expect(selection.sessionStore.identity).toEqual(identity(roots.currentSessionRoot));
			expect(record.opened).toEqual([{ workspaceRef: cwd, stateRoot: toNamespacedPath(roots.currentSessionRoot) }]);
			expect(existsSync(roots.legacyRoot)).toBe(false);
			expect(existsSync(roots.defaultRoot)).toBe(true);
		});

		it("opens the legacy store as recorded while both roots exist", async () => {
			const roots = layout();
			mkdirSync(roots.legacySessionRoot, { recursive: true });
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const record = recordOpens(roots);

			const selection = await resumeFrom(roots.legacySessionRoot);
			await selection.sessionStore.dispose();

			expect(selection).toMatchObject({ resumeAttemptAllowed: true, resumeFallback: false });
			expect(selection.sessionStore.identity).toEqual(identity(roots.legacySessionRoot));
			expect(record.opened).toEqual([{ workspaceRef: cwd, stateRoot: toNamespacedPath(roots.legacySessionRoot) }]);
		});

		it("attempts the resume at the mapped location even when the store there is gone", async () => {
			const roots = layout();
			const record = recordOpens(roots);

			const selection = await resumeFrom(roots.legacySessionRoot);
			await selection.sessionStore.dispose();

			expect(selection).toMatchObject({ resumeAttemptAllowed: true, resumeFallback: false });
			expect(selection.sessionStore.identity).toEqual(identity(roots.currentSessionRoot));
			expect(record.opened).toEqual([{ workspaceRef: cwd, stateRoot: toNamespacedPath(roots.currentSessionRoot) }]);
		});

		it("never maps a legacy identity for a fileless acquisition", async () => {
			const roots = layout();
			mkdirSync(roots.currentSessionRoot, { recursive: true });
			const record = recordOpens(roots);

			const selection = await resumeFrom(roots.legacySessionRoot, false);
			await selection.sessionStore.dispose();

			expect(selection.resumeAttemptAllowed).toBe(false);
			expect(record.opened.map((options) => options.stateRoot)).not.toContain(toNamespacedPath(roots.legacySessionRoot));
			expect(record.opened.map((options) => options.stateRoot)).not.toContain(toNamespacedPath(roots.currentSessionRoot));
		});

		it.skipIf(process.platform === "win32")("fails, rather than falling back, when the legacy root cannot be inspected", async () => {
			const roots = layout();
			mkdirSync(dirname(roots.legacyRoot), { recursive: true });
			symlinkSync(roots.legacyRoot, roots.legacyRoot);
			const record = recordOpens(roots);

			await expect(resumeFrom(roots.legacySessionRoot)).rejects.toMatchObject({ code: "ELOOP" });
			expect(record.opened).toEqual([]);
		});

		describe("through acquireSessionCursorAgent", () => {
			beforeEach(async () => {
				scopeTestUtils.reset();
				resumeTestUtils.reset();
				await sessionAgentTestUtils.disposeAllSessionCursorAgents();
			});

			afterEach(() => sessionAgentTestUtils.disposeAllSessionCursorAgents());

			/** A session whose recorded resume handle names `recorded`, with an SDK that does not know the agent. */
			function acquireFrom(roots: Layout, recorded: string) {
				const record = recordOpens(roots);
				const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
				const resumeAgent = vi.fn().mockRejectedValue(new Error("Agent agent-recorded not found"));
				scopeTestUtils.set(cwd, scopeKey);
				const params = {
					apiKey: "test-key",
					agentMode: "agent" as const,
					cwd,
					modelSelection: { id: "composer-2.5" },
					localResume: true,
					createAgent,
					resumeAgent,
				};
				resumeTestUtils.set({
					scopeKey,
					sessionFile: scopeKey,
					cwd,
					branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
					compactionGeneration: 0,
					activeHandle: {
						version: 2,
						runtime: "local",
						agentId: "agent-recorded",
						scopeKey,
						sessionFile: scopeKey,
						cwd,
						poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
						branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
						compactionGeneration: 0,
						sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
						createdAt: "2026-10-22T00:00:00.000Z",
						storeIdentity: identity(recorded),
					},
				});
				return { record, createAgent, resumeAgent, acquire: () => acquireSessionCursorAgent(params) };
			}

			it("falls back to a fresh agent in the mapped session store when the agent is not found there", async () => {
				const roots = layout();
				const { record, createAgent, resumeAgent, acquire } = acquireFrom(roots, roots.legacySessionRoot);

				const lease = await acquire();

				expect(resumeAgent).toHaveBeenCalledTimes(1);
				expect(resumeAgent.mock.calls[0]![0]).toBe("agent-recorded");
				expect(lease.resumed).toBe(false);
				expect(lease.resumeNotice).toContain("Could not resume prior Cursor agent");
				expect(lease.agent.agentId).toBe("agent-new");
				// The mapped session store is this session's store, so the fresh agent is created in the store the resume used.
				expect(lease.storeIdentity).toEqual(identity(roots.currentSessionRoot));
				expect(record.opened).toEqual([{ workspaceRef: cwd, stateRoot: toNamespacedPath(roots.currentSessionRoot) }]);
				expect(createAgent.mock.calls[0]![0].local?.store).toBe(record.stores[0]);
				expect(record.disposed).toEqual([]);
			});

			it("replaces a mapped legacy default store with the session store for the fresh agent", async () => {
				const roots = layout();
				const { record, createAgent, resumeAgent, acquire } = acquireFrom(roots, roots.legacyRoot);

				const lease = await acquire();

				expect(resumeAgent.mock.calls[0]![1]?.local?.store).toBe(record.stores[0]);
				expect(lease.resumed).toBe(false);
				expect(lease.resumeNotice).toContain("Could not resume prior Cursor agent");
				expect(lease.storeIdentity).toEqual(identity(roots.currentSessionRoot));
				expect(record.opened.map((options) => options.stateRoot)).toEqual([
					toNamespacedPath(roots.defaultRoot),
					toNamespacedPath(roots.currentSessionRoot),
				]);
				expect(record.disposed).toEqual([toNamespacedPath(roots.defaultRoot)]);
				expect(createAgent.mock.calls[0]![0].local?.store).toBe(record.stores[1]);
			});
		});
	});
});
