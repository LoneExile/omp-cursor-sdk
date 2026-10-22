import { createHash, randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, toNamespacedPath } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";

export interface CursorSessionStoreIdentity {
	readonly version: 1;
	readonly stateRoot: string;
}

export interface OpenCursorSessionStore {
	identity: CursorSessionStoreIdentity;
	store: LocalAgentStore;
	dispose(): Promise<void>;
}

export interface CursorSessionStoreIdentities {
	defaultStore: CursorSessionStoreIdentity;
	sessionStore: CursorSessionStoreIdentity;
	/**
	 * The same two stores under the MD5-derived workspace root `@cursor/sdk` used before 1.0.35. Present only for a
	 * persisted session whose default root is the SHA-256-derived one (see `deriveLegacyCursorSdkStateRoot`).
	 */
	legacy?: {
		defaultStore: CursorSessionStoreIdentity;
		sessionStore: CursorSessionStoreIdentity;
	};
}

export type CursorSessionStoreKind = "defaultStore" | "sessionStore";

export interface CursorSessionStoreSelection {
	sessionStore: OpenCursorSessionStore;
	identities: CursorSessionStoreIdentities;
	resumeAttemptAllowed: boolean;
	resumeFallback: boolean;
}

interface CursorSessionStoreSdkOperations {
	getDefaultStateRoot(cwd: string): string | Promise<string>;
	openSqliteStore(options: { workspaceRef: string; stateRoot: string }): Promise<LocalAgentStore & { dispose(): Promise<void> }>;
}

let sdkOperationsForTests: CursorSessionStoreSdkOperations | undefined;

export function hashCursorSessionStoreScope(scopeKey: string): string {
	return createHash("sha256")
		.update("pi-cursor-sdk-session-store\0")
		.update(scopeKey)
		.digest("hex")
		.slice(0, 32);
}

export function buildCursorSessionStateRoot(defaultStateRoot: string, scopeKey: string, persistent: boolean): string {
	const baseRoot = persistent ? defaultStateRoot : join(tmpdir(), `pi-cursor-sdk-${randomUUID()}`);
	return join(baseRoot, "pi-sessions", hashCursorSessionStoreScope(scopeKey));
}

async function getSdkOperations(): Promise<CursorSessionStoreSdkOperations> {
	if (sdkOperationsForTests) return sdkOperationsForTests;
	const [{ getDefaultSdkStateRoot }, { SqliteLocalAgentStore }] = await Promise.all([
		loadCursorSdk(),
		import("@cursor/sdk/sqlite"),
	]);
	return {
		getDefaultStateRoot: getDefaultSdkStateRoot,
		openSqliteStore: (options) => SqliteLocalAgentStore.open(options),
	};
}

/**
 * `@cursor/sdk` before 1.0.35 put a workspace's state at `<project dir>/sdk-agent-store/md5(workspaceRef)`; since
 * 1.0.35 it is `.../sha256(workspaceRef)`, and `getDefaultSdkStateRoot` renames an existing MD5 directory into the
 * SHA-256 path the first time it runs while no SHA-256 directory exists. Only the last path segment differs, so the
 * legacy root is derived from the SDK's own answer rather than by re-implementing its project directory. `undefined`
 * unless that answer is the SHA-256 layout for this exact `cwd` (a custom root, a failed rename that left the SDK
 * answering with the MD5 path, or a runtime without MD5). `test/cursor-session-store-legacy-root.test.ts` pins both
 * hashes and the rename against the installed SDK.
 */
export function deriveLegacyCursorSdkStateRoot(defaultStateRoot: string, cwd: string): string | undefined {
	if (basename(defaultStateRoot) !== createHash("sha256").update(cwd).digest("hex")) return undefined;
	try {
		return join(dirname(defaultStateRoot), createHash("md5").update(cwd).digest("hex"));
	} catch {
		// FIPS builds reject MD5; the SDK skips its rename there too, so no recorded identity can have moved.
		return undefined;
	}
}

export async function getCursorSessionStoreIdentities(
	cwd: string,
	scopeKey: string,
	persistent: boolean,
): Promise<CursorSessionStoreIdentities> {
	const defaultStateRoot = await (await getSdkOperations()).getDefaultStateRoot(cwd);
	const legacyStateRoot = persistent ? deriveLegacyCursorSdkStateRoot(defaultStateRoot, cwd) : undefined;
	return {
		defaultStore: { version: 1, stateRoot: defaultStateRoot },
		sessionStore: {
			version: 1,
			stateRoot: buildCursorSessionStateRoot(defaultStateRoot, scopeKey, persistent),
		},
		...(legacyStateRoot
			? {
				legacy: {
					defaultStore: { version: 1 as const, stateRoot: legacyStateRoot },
					sessionStore: {
						version: 1 as const,
						stateRoot: buildCursorSessionStateRoot(legacyStateRoot, scopeKey, persistent),
					},
				},
			}
			: {}),
	};
}

export function cursorSessionStoreIdentitiesEqual(
	left: CursorSessionStoreIdentity,
	right: CursorSessionStoreIdentity,
): boolean {
	return left.version === right.version && left.stateRoot === right.stateRoot;
}

/** Absent is ENOENT/ENOTDIR only: any other error (EACCES, EMFILE, ...) says nothing about whether the path exists. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

/**
 * The identity to open for a recorded one, or `undefined` when it does not belong to this session. A recorded identity
 * is admitted only if it is one of this session's current `admissible` stores, or its exact MD5-derived counterpart:
 *
 * - the legacy root is gone: the SDK moved it, so the store is the current one;
 * - the legacy root exists: the SDK leaves an MD5 root alone once a SHA-256 one exists, so the recorded store is used
 *   where it is. Two roots are never merged.
 *
 * The mapped store is not checked for existence, so a store that is gone behaves as it does for a current identity:
 * it is opened empty and the SDK reports the agent as not found. Resolution opens nothing and creates nothing, and an
 * existence check that fails for any reason but absence propagates instead of rejecting the identity.
 */
export async function admitRecordedCursorSessionStoreIdentity(
	recorded: CursorSessionStoreIdentity,
	identities: CursorSessionStoreIdentities,
	admissible: readonly CursorSessionStoreKind[],
): Promise<CursorSessionStoreIdentity | undefined> {
	for (const kind of admissible) {
		if (cursorSessionStoreIdentitiesEqual(identities[kind], recorded)) return identities[kind];
	}
	const { legacy } = identities;
	if (!legacy) return undefined;
	for (const kind of admissible) {
		if (!cursorSessionStoreIdentitiesEqual(legacy[kind], recorded)) continue;
		return (await pathExists(legacy.defaultStore.stateRoot)) ? legacy[kind] : identities[kind];
	}
	return undefined;
}

async function openOwnedCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
	removalRoot?: string,
): Promise<OpenCursorSessionStore> {
	const openedIdentity = Object.freeze({ ...identity });
	let store: LocalAgentStore & { dispose(): Promise<void> };
	try {
		store = await (await getSdkOperations()).openSqliteStore({
			workspaceRef: cwd,
			stateRoot: toNamespacedPath(openedIdentity.stateRoot),
		});
	} catch (error) {
		if (removalRoot) await rm(removalRoot, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return {
		identity: openedIdentity,
		store,
		dispose: async () => {
			try {
				await store.dispose();
			} finally {
				if (removalRoot) await rm(removalRoot, { recursive: true, force: true });
			}
		},
	};
}

export function openCursorSessionStore(
	cwd: string,
	identity: CursorSessionStoreIdentity,
): Promise<OpenCursorSessionStore> {
	return openOwnedCursorSessionStore(cwd, identity);
}

export async function openCursorSessionStoreForScope(options: {
	cwd: string;
	scopeKey: string;
	persistent: boolean;
	hasResumeHandle: boolean;
	resumeIdentity?: CursorSessionStoreIdentity;
}): Promise<CursorSessionStoreSelection> {
	const identities = await getCursorSessionStoreIdentities(options.cwd, options.scopeKey, options.persistent);
	const requestedResumeIdentity = options.hasResumeHandle
		? options.resumeIdentity ?? (options.persistent ? identities.defaultStore : undefined)
		: undefined;
	const resumeIdentity = requestedResumeIdentity && await admitRecordedCursorSessionStoreIdentity(
		requestedResumeIdentity,
		identities,
		options.persistent ? ["defaultStore", "sessionStore"] : ["sessionStore"],
	);
	let resumeAttemptAllowed = options.hasResumeHandle && resumeIdentity !== undefined;
	let resumeFallback = options.persistent && options.hasResumeHandle && !resumeIdentity;
	const selectedIdentity = resumeIdentity ?? identities.sessionStore;
	const removalRoot = options.persistent ? undefined : dirname(dirname(identities.sessionStore.stateRoot));
	let sessionStore: OpenCursorSessionStore;
	try {
		sessionStore = await openOwnedCursorSessionStore(options.cwd, selectedIdentity, removalRoot);
	} catch (error) {
		if (!resumeIdentity || cursorSessionStoreIdentitiesEqual(resumeIdentity, identities.sessionStore)) throw error;
		resumeAttemptAllowed = false;
		resumeFallback = true;
		sessionStore = await openOwnedCursorSessionStore(options.cwd, identities.sessionStore);
	}
	return { sessionStore, identities, resumeAttemptAllowed, resumeFallback };
}

export const __testUtils = {
	setSdkOperations(operations: CursorSessionStoreSdkOperations | undefined): void {
		sdkOperationsForTests = operations;
	},
};
