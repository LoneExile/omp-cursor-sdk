import { createHash } from "node:crypto";
import type { AgentModeOption, LocalAgentOptions, LocalAgentStore, ModelSelection, SDKAgent, SettingSource, ToolName } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import {
	getRegisteredCursorPiToolBridge,
	type CursorPiBridgeToolRequest,
	type CursorPiToolBridgeRun,
} from "./cursor-pi-tool-bridge.js";
import { computeCursorContextFingerprint } from "./context.js";
import { getCursorSessionFile, getCursorSessionScopeGeneration, getCursorSessionScopeKey } from "./cursor-session-scope.js";
import {
	getMatchingCursorSessionAgentResumeHandle,
	persistCursorSessionAgentResumeHandle,
} from "./cursor-session-agent-resume.js";
import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { loadCursorSdk, type CursorSdkModule } from "./cursor-sdk-runtime.js";
import {
	cursorSessionStoreIdentitiesEqual,
	openCursorSessionStore,
	openCursorSessionStoreForScope,
	type CursorSessionStoreIdentity,
	type OpenCursorSessionStore,
} from "./cursor-session-store.js";

export interface SessionCursorAgentSendState {
	bootstrapped: boolean;
	contextFingerprint: string;
	incrementalSendCount: number;
}

export interface SessionCursorAgentLease {
	scopeKey: string;
	poolKey: string;
	instanceId: number;
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	store: LocalAgentStore;
	storeIdentity: CursorSessionStoreIdentity;
	sendState: SessionCursorAgentSendState;
	created: boolean;
	resumed?: boolean;
	resumeNotice?: string;
	commitSend(context: Context, bootstrapped: boolean): void;
	trackRunCompletion(completion: Promise<unknown>): void;
}

interface SessionCursorAgentPoolEntryBase {
	poolKey: string;
	instanceId: number;
	scopeKey: string;
	sendState: SessionCursorAgentSendState;
}

interface SessionCursorAgentCreatingEntry extends SessionCursorAgentPoolEntryBase {
	status: "creating";
	creating: Promise<SessionCursorAgentReadyEntry>;
	creationGeneration: number;
}

interface SessionCursorAgentReadyEntry extends SessionCursorAgentPoolEntryBase {
	status: "ready";
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionStore: OpenCursorSessionStore;
	resumeEnabled: boolean;
	resumed: boolean;
	resumeNotice?: string;
}

interface SessionCursorAgentBusyEntry extends SessionCursorAgentPoolEntryBase {
	status: "busy";
	agent: SDKAgent;
	bridgeRun?: CursorPiToolBridgeRun;
	sessionStore: OpenCursorSessionStore;
	resumeEnabled: boolean;
	resumed: boolean;
	resumeNotice?: string;
	completionSettled: Promise<void>;
	pendingCompletion: Promise<void>;
	releaseBusyWait: () => void;
	busyGeneration: number;
}

type SessionCursorAgentActiveEntry = SessionCursorAgentReadyEntry | SessionCursorAgentBusyEntry;
type SessionCursorAgentPoolEntry =
	| SessionCursorAgentCreatingEntry
	| SessionCursorAgentReadyEntry
	| SessionCursorAgentBusyEntry;

type SessionCursorAgentPoolState = { status: "empty" } | SessionCursorAgentPoolEntry;

class SessionCursorAgentCreationSupersededError extends Error {
	constructor() {
		super("Cursor session agent creation was superseded");
		this.name = "SessionCursorAgentCreationSupersededError";
	}
}

export class SessionCursorAgentScopeClosedError extends Error {
	constructor() {
		super("Cursor session agent scope is closed");
		this.name = "SessionCursorAgentScopeClosedError";
	}
}

function assertScopeAcceptsAcquire(scopeKey: string): void {
	const terminalGeneration = terminalDisposedScopeGenerations.get(scopeKey);
	if (terminalGeneration === undefined) return;
	if (terminalGeneration >= getCursorSessionScopeGeneration(scopeKey)) {
		throw new SessionCursorAgentScopeClosedError();
	}
	terminalDisposedScopeGenerations.delete(scopeKey);
}

function getAcquireScopeKey(scopeKey: string): string {
	const terminalGeneration = terminalDisposedScopeGenerations.get(scopeKey);
	if (terminalGeneration === undefined || terminalGeneration < getCursorSessionScopeGeneration(scopeKey)) {
		return scopeKey;
	}
	// OMP may run a background advisor after session_shutdown. Keep the
	// interactive scope terminally closed, but let that late turn use a
	// fresh, isolated SDK agent scope.
	const background = `${scopeKey}::background`;
	backgroundScopeKeys.add(background);
	return background;
}

function rethrowSupersededWhenReplacedByDifferentPoolKey(scopeKey: string, poolKey: string, error: unknown): void {
	if (!(error instanceof SessionCursorAgentCreationSupersededError)) return;
	const replacement = sessionAgentsByScope.get(scopeKey);
	if (replacement && replacement.poolKey !== poolKey) {
		throw error;
	}
}

interface SessionCursorAgentCreateParams {
	apiKey: string;
	agentMode: AgentModeOption;
	cwd: string;
	modelSelection: ModelSelection;
	settingSources?: SettingSource[];
	localSafety?: CursorLocalSafetyOptions;
	useHttp1ForAgent?: boolean;
	onBridgeToolRequest?: (request: CursorPiBridgeToolRequest) => void;
	debugRecorder?: CursorSdkEventDebugRecorder;
	localResume?: boolean;
	forceCreate?: boolean;
	createAgent?: CursorSdkModule["Agent"]["create"];
	resumeAgent?: CursorSdkModule["Agent"]["resume"];
	/**
	 * omp provider session id of the conversation the agent serves (the request's
	 * `options.sessionId`). Each conversation of a session scope gets its own pool entry
	 * (see sessionAgentEntryKey), so an advisor loop never replaces, blocks or resets the
	 * main conversation's agent.
	 */
	conversationId?: string;
	/**
	 * The session's own conversation (default). Other conversations (an advisor loop) get
	 * no pi tool bridge, a temporary store and no local-resume handle: omp tools execute
	 * only in the main loop, and only the main conversation is resumed or cleaned up.
	 */
	mainConversation?: boolean;
	/**
	 * Cursor built-in tools the agent may use (the SDK's `tools` allowlist); undefined keeps
	 * the SDK's default toolset. Set for omp advisor and summarizer requests (see getCursorBuiltInToolAllowlist).
	 */
	builtInTools?: ToolName[];
}

const CONVERSATION_ENTRY_SEPARATOR = "\u0000conversation:";

/**
 * Pool entry key of one conversation in a session scope. Scope-level operations (reset,
 * invalidate, dispose) cover every conversation entry of the scope.
 */
export function sessionAgentEntryKey(scopeKey: string, conversationId: string | undefined): string {
	return conversationId ? `${scopeKey}${CONVERSATION_ENTRY_SEPARATOR}${conversationId}` : scopeKey;
}

function isEntryOfScope(entryKey: string, scopeKey: string): boolean {
	return entryKey === scopeKey || entryKey.startsWith(`${scopeKey}${CONVERSATION_ENTRY_SEPARATOR}`);
}

const sessionAgentsByScope = new Map<string, SessionCursorAgentPoolEntry>();
const invalidatedScopeKeys = new Set<string>();
const deadTransportScopeKeys = new Set<string>();
let deadTransportAgentDisposeTimeoutMs = 3000;
const terminalDisposedScopeGenerations = new Map<string, number>();
// Minted `<scope>::background` pool keys (advisor turns after session
// shutdown). Tracked so disposeSessionCursorAgent can reclaim them; without
// this they would live in sessionAgentsByScope until process exit.
const backgroundScopeKeys = new Set<string>();
const scopeCreationGenerations = new Map<string, number>();
const EMPTY_POOL_STATE: SessionCursorAgentPoolState = { status: "empty" };
const LOCAL_RESUME_FALLBACK_NOTICE = "Could not resume prior Cursor agent; continuing from current pi transcript in a new Cursor agent.";
let nextSessionAgentInstanceId = 1;

export interface CursorLocalSafetyOptions {
	autoReview?: boolean;
	sandboxEnabled?: boolean;
}

export function buildCursorLocalAgentOptions(options: {
	cwd: string;
	settingSources?: SettingSource[];
	localSafety?: CursorLocalSafetyOptions;
	store?: LocalAgentStore;
}): LocalAgentOptions {
	return {
		cwd: options.cwd,
		...(options.store ? { store: options.store } : {}),
		...(options.settingSources ? { settingSources: options.settingSources } : {}),
		...(options.localSafety?.autoReview === true ? { autoReview: true } : {}),
		...(options.localSafety?.sandboxEnabled === true ? { sandboxOptions: { enabled: true } } : {}),
	};
}

function allocateSessionAgentInstanceId(): number {
	return nextSessionAgentInstanceId++;
}

function getSessionCursorAgentPoolState(scopeKey: string): SessionCursorAgentPoolState {
	return sessionAgentsByScope.get(scopeKey) ?? EMPTY_POOL_STATE;
}

function isActivePoolEntry(entry: SessionCursorAgentPoolEntry | undefined): entry is SessionCursorAgentActiveEntry {
	return entry?.status === "ready" || entry?.status === "busy";
}

function getScopeCreationGeneration(scopeKey: string): number {
	return scopeCreationGenerations.get(scopeKey) ?? 0;
}

function invalidateScopeCreations(scopeKey: string): void {
	scopeCreationGenerations.set(scopeKey, getScopeCreationGeneration(scopeKey) + 1);
}

function buildModelPoolKey(modelSelection: ModelSelection): string {
	return JSON.stringify(modelSelection);
}

function buildSettingSourcesPoolKey(settingSources?: SettingSource[]): string {
	return settingSources?.join(",") ?? "";
}

function buildLocalSafetyPoolKey(localSafety?: CursorLocalSafetyOptions): string {
	return JSON.stringify({
		autoReview: localSafety?.autoReview === true,
		sandboxEnabled: localSafety?.sandboxEnabled === true,
	});
}

function buildApiKeyPoolKeyFingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function buildBridgePoolKeySuffix(mainConversation: boolean): string {
	if (!mainConversation) return "bridge:off";
	const registeredBridge = getRegisteredCursorPiToolBridge();
	if (!registeredBridge) return "bridge:absent";
	return registeredBridge.getToolSurfaceSignature();
}

function buildSessionAgentPoolKey(scopeKey: string, params: SessionCursorAgentCreateParams): string {
	return [
		scopeKey,
		`conversation:${params.conversationId ?? ""}`,
		params.cwd,
		buildModelPoolKey(params.modelSelection),
		buildSettingSourcesPoolKey(params.settingSources),
		buildLocalSafetyPoolKey(params.localSafety),
		params.useHttp1ForAgent === undefined
			? "http1:default"
			: params.useHttp1ForAgent
				? "http1:on"
				: "http1:off",
		buildApiKeyPoolKeyFingerprint(params.apiKey),
		buildBridgePoolKeySuffix(params.mainConversation !== false),
		// Only a restricted agent's key names its tools: unrestricted keys, and the local-resume
		// handles persisted with them (matched by exact key), stay as they were.
		...(params.builtInTools === undefined ? [] : [`tools:${params.builtInTools.join(",")}`]),
	].join("\0");
}

async function disposePoolEntry(entry: SessionCursorAgentPoolEntry, options?: { deadTransport?: boolean }): Promise<void> {
	if (!isActivePoolEntry(entry)) return;
	entry.bridgeRun?.cancel("Cursor session agent disposed");
	try {
		await entry.bridgeRun?.dispose();
	} catch {
		// disposal failure should not block session replacement
	}
	try {
		const disposal = Promise.resolve(entry.agent[Symbol.asyncDispose]()).catch(() => undefined);
		// A dead local transport may never settle SDK disposal; bound the wait so the
		// next acquire recreates instead of hanging on the dead agent.
		await (options?.deadTransport
			? Promise.race([
					disposal,
					new Promise<void>((resolve) => setTimeout(resolve, deadTransportAgentDisposeTimeoutMs).unref?.()),
				])
			: disposal);
	} catch {
		// disposal failure should not block session replacement
	}
	await entry.sessionStore.dispose().catch(() => undefined);
}

/** Dispose every conversation entry of a scope (or the single entry an entry key names). */
async function disposePoolEntryForScope(scopeKey: string, options?: { terminal?: boolean }): Promise<void> {
	if (options?.terminal) {
		terminalDisposedScopeGenerations.set(scopeKey, getCursorSessionScopeGeneration(scopeKey));
	}
	const entryKeys = new Set([scopeKey, ...[...sessionAgentsByScope.keys()].filter((key) => isEntryOfScope(key, scopeKey))]);
	await Promise.all([...entryKeys].map((entryKey) => disposePoolEntryForKey(entryKey)));
}

async function disposePoolEntryForKey(entryKey: string): Promise<void> {
	invalidateScopeCreations(entryKey);
	const entry = sessionAgentsByScope.get(entryKey);
	invalidatedScopeKeys.delete(entryKey);
	const deadTransport = deadTransportScopeKeys.delete(entryKey);
	if (!entry) return;
	sessionAgentsByScope.delete(entryKey);
	if (entry.status === "busy") {
		entry.releaseBusyWait();
	}
	if (entry.status === "creating") {
		entry.creating.catch(() => {
			// In-flight Agent.create was orphaned by scope disposal; active waiters surface errors elsewhere.
		});
		return;
	}
	await disposePoolEntry(entry, { deadTransport });
}

function isResumeEnabled(params: SessionCursorAgentCreateParams): boolean {
	return params.localResume === true && params.mainConversation !== false;
}

function createInitialSendState(): SessionCursorAgentSendState {
	return { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 };
}

function bindBridgeToolRequest(
	entry: SessionCursorAgentActiveEntry,
	onBridgeToolRequest?: (request: CursorPiBridgeToolRequest) => void,
): void {
	entry.bridgeRun?.setOnToolRequest(onBridgeToolRequest);
}

function commitSessionAgentSendForLease(
	scopeKey: string,
	poolKey: string,
	instanceId: number,
	context: Context,
	bootstrapped: boolean,
): void {
	const entry = sessionAgentsByScope.get(scopeKey);
	if (!isActivePoolEntry(entry)) return;
	if (entry.poolKey !== poolKey || entry.instanceId !== instanceId) return;
	entry.sendState.bootstrapped = bootstrapped || entry.sendState.bootstrapped;
	entry.sendState.contextFingerprint = computeCursorContextFingerprint(context);
	if (bootstrapped) {
		entry.sendState.incrementalSendCount = 0;
	} else {
		entry.sendState.incrementalSendCount += 1;
	}
	if (entry.resumeEnabled) {
		persistCursorSessionAgentResumeHandle({
			runtime: "local",
			agentId: entry.agent.agentId,
			poolKey: entry.poolKey,
			sendState: entry.sendState,
			storeIdentity: entry.sessionStore.identity,
		});
	}
}

function normalizeRunCompletion(completion: Promise<unknown>): Promise<void> {
	return Promise.resolve(completion).then(
		() => undefined,
		() => undefined,
	);
}

function buildBusyPoolEntry(
	entry: SessionCursorAgentActiveEntry,
	completionSettled: Promise<void>,
): SessionCursorAgentBusyEntry {
	let releaseBusyWait = (): void => {};
	const releaseSignal = new Promise<"released">((resolve) => {
		releaseBusyWait = () => resolve("released");
	});
	const pendingCompletion = Promise.race([
		completionSettled.then(() => "completed" as const),
		releaseSignal,
	]).then((outcome) => {
		const current = sessionAgentsByScope.get(entry.scopeKey);
		if (
			outcome === "completed" &&
			current?.status === "busy" &&
			current.poolKey === entry.poolKey &&
			current.instanceId === entry.instanceId &&
			current.pendingCompletion === pendingCompletion
		) {
			sessionAgentsByScope.set(entry.scopeKey, { ...current, status: "ready" });
		}
	});

	return {
		...entry,
		status: "busy",
		completionSettled,
		pendingCompletion,
		releaseBusyWait,
		busyGeneration: getScopeCreationGeneration(entry.scopeKey),
	};
}

function trackSessionAgentRunCompletionForLease(
	scopeKey: string,
	poolKey: string,
	instanceId: number,
	completion: Promise<unknown>,
): void {
	const entry = sessionAgentsByScope.get(scopeKey);
	if (!isActivePoolEntry(entry)) return;
	if (entry.poolKey !== poolKey || entry.instanceId !== instanceId) return;

	const completionToTrack = normalizeRunCompletion(completion);
	const completionSettled = (entry.status === "busy"
		? Promise.all([entry.completionSettled, completionToTrack]).then(() => undefined)
		: completionToTrack
	);
	if (entry.status === "busy") {
		entry.releaseBusyWait();
	}

	sessionAgentsByScope.set(scopeKey, buildBusyPoolEntry(entry, completionSettled));
}

function leaseFromEntry(
	entry: SessionCursorAgentReadyEntry,
	scopeKey: string,
	params: SessionCursorAgentCreateParams,
	created: boolean,
): SessionCursorAgentLease {
	entry.resumeEnabled = isResumeEnabled(params);
	bindBridgeToolRequest(entry, params.onBridgeToolRequest);
	entry.bridgeRun?.setDebugRecorder(params.debugRecorder);
	const resumeNotice = entry.resumeNotice;
	entry.resumeNotice = undefined;
	return {
		scopeKey,
		poolKey: entry.poolKey,
		instanceId: entry.instanceId,
		agent: entry.agent,
		bridgeRun: entry.bridgeRun,
		store: entry.sessionStore.store,
		storeIdentity: entry.sessionStore.identity,
		sendState: entry.sendState,
		created,
		resumed: entry.resumed,
		...(resumeNotice ? { resumeNotice } : {}),
		commitSend: (context, bootstrapped) => {
			commitSessionAgentSendForLease(scopeKey, entry.poolKey, entry.instanceId, context, bootstrapped);
		},
		trackRunCompletion: (completion) => {
			trackSessionAgentRunCompletionForLease(scopeKey, entry.poolKey, entry.instanceId, completion);
		},
	};
}

function getCurrentReadyPoolEntry(scopeKey: string, poolKey: string): SessionCursorAgentReadyEntry | undefined {
	const current = sessionAgentsByScope.get(scopeKey);
	if (current?.status !== "ready") return undefined;
	if (current.poolKey !== poolKey) return undefined;
	return current;
}

async function tryLeaseReadyEntry(
	entry: SessionCursorAgentActiveEntry,
	scopeKey: string,
	entryKey: string,
	params: SessionCursorAgentCreateParams,
	poolKey: string,
	created: boolean,
): Promise<SessionCursorAgentLease | undefined> {
	if (entry.status === "busy") {
		await entry.pendingCompletion;
	}
	assertScopeAcceptsAcquire(scopeKey);
	if (invalidatedScopeKeys.has(entryKey)) {
		await disposePoolEntryForKey(entryKey);
		return undefined;
	}
	const readyEntry = getCurrentReadyPoolEntry(entryKey, poolKey);
	if (!readyEntry) return undefined;
	return leaseFromEntry(readyEntry, entryKey, params, created);
}

async function createSessionAgentEntry(
	scopeKey: string,
	entryKey: string,
	persistentStore: boolean,
	instanceId: number,
	sendState: SessionCursorAgentSendState,
	params: SessionCursorAgentCreateParams,
): Promise<SessionCursorAgentReadyEntry> {
	let bridgeRun: CursorPiToolBridgeRun | undefined;
	let sessionStore: OpenCursorSessionStore | undefined;
	try {
		const registeredBridge = params.mainConversation === false ? undefined : getRegisteredCursorPiToolBridge();
		if (registeredBridge) {
			bridgeRun = await registeredBridge.createRun({
				onToolRequest: params.onBridgeToolRequest,
				debugRecorder: params.debugRecorder,
			});
			if (!bridgeRun.enabled || !bridgeRun.mcpServers) {
				await bridgeRun.dispose();
				bridgeRun = undefined;
			}
		}

		const resolvedPoolKey = buildSessionAgentPoolKey(scopeKey, params);
		const resumeEligible = isResumeEnabled(params) && !params.forceCreate;
		let createAgent = params.createAgent;
		let resumeAgent = params.resumeAgent;
		if (!createAgent || (resumeEligible && !resumeAgent)) {
			const sdk = await loadCursorSdk();
			createAgent ??= sdk.Agent.create;
			resumeAgent ??= sdk.Agent.resume;
		}
		const resumeHandle = resumeEligible ? getMatchingCursorSessionAgentResumeHandle(resolvedPoolKey) : undefined;
		const storeSelection = await openCursorSessionStoreForScope({
			cwd: params.cwd,
			scopeKey: entryKey,
			persistent: persistentStore,
			hasResumeHandle: resumeHandle !== undefined,
			resumeIdentity: resumeHandle?.storeIdentity,
		});
		sessionStore = storeSelection.sessionStore;
		const { identities } = storeSelection;
		const resumeAttemptAllowed = storeSelection.resumeAttemptAllowed;
		let resumeNotice = storeSelection.resumeFallback ? LOCAL_RESUME_FALLBACK_NOTICE : undefined;
		const buildAgentOptions = () => ({
			apiKey: params.apiKey,
			model: params.modelSelection,
			mode: params.agentMode,
			local: buildCursorLocalAgentOptions({
				cwd: params.cwd,
				settingSources: params.settingSources,
				localSafety: params.localSafety,
				store: sessionStore!.store,
			}),
			...(bridgeRun?.mcpServers ? { mcpServers: bridgeRun.mcpServers } : {}),
			...(params.builtInTools !== undefined ? { tools: params.builtInTools } : {}),
		});
		let agent: SDKAgent | undefined;
		let effectiveSendState = sendState;
		let resumed = false;
		if (resumeHandle && resumeAttemptAllowed && resumeAgent) {
			try {
				agent = await resumeAgent(resumeHandle.agentId, buildAgentOptions());
				effectiveSendState = { ...resumeHandle.sendState };
				resumed = true;
			} catch {
				if (persistentStore) resumeNotice = LOCAL_RESUME_FALLBACK_NOTICE;
				if (!cursorSessionStoreIdentitiesEqual(sessionStore.identity, identities.sessionStore)) {
					await sessionStore.dispose().catch(() => undefined);
					sessionStore = await openCursorSessionStore(params.cwd, identities.sessionStore);
				}
			}
		}
		agent ??= await createAgent(buildAgentOptions());
		if (!agent) throw new Error("Cursor SDK agent creation returned no agent");
		if (!sessionStore) throw new Error("Cursor SDK session store was not opened");

		return {
			status: "ready",
			poolKey: resolvedPoolKey,
			instanceId,
			scopeKey: entryKey,
			agent,
			bridgeRun,
			sessionStore,
			sendState: effectiveSendState,
			resumeEnabled: isResumeEnabled(params),
			resumed,
			...(resumeNotice ? { resumeNotice } : {}),
		};
	} catch (error) {
		bridgeRun?.cancel("Cursor session agent create failed");
		await bridgeRun?.dispose().catch(() => undefined);
		await sessionStore?.dispose().catch(() => undefined);
		throw error;
	}
}

export {
	buildCursorSessionSendPrompt,
	MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
	planCursorSessionSend,
	type CursorSessionSendPlan,
} from "./cursor-session-send-policy.js";

export function invalidateSessionAgent(
	scopeKey: string = getCursorSessionScopeKey(),
	options?: { deadTransport?: boolean },
): void {
	for (const entryKey of [scopeKey, ...sessionAgentsByScope.keys()]) {
		if (!isEntryOfScope(entryKey, scopeKey)) continue;
		invalidatedScopeKeys.add(entryKey);
		if (options?.deadTransport) deadTransportScopeKeys.add(entryKey);
	}
}

export interface OneShotCursorAgentLease extends SessionCursorAgentLease {
	oneShot: true;
	dispose(): Promise<void>;
}

export function isOneShotCursorAgentLease(lease: SessionCursorAgentLease): lease is OneShotCursorAgentLease {
	return (lease as Partial<OneShotCursorAgentLease>).oneShot === true;
}

/**
 * SDK agent for a request that is not part of the pooled session conversation (omp's
 * compaction summarizer). It never enters the pool, has no pi tool bridge, never
 * resumes or persists a resume handle, and uses a temporary store removed on dispose.
 */
export async function createOneShotCursorAgent(params: SessionCursorAgentCreateParams): Promise<OneShotCursorAgentLease> {
	const scopeKey = `${getCursorSessionScopeKey()}::one-shot:${allocateSessionAgentInstanceId()}`;
	const { sessionStore } = await openCursorSessionStoreForScope({
		cwd: params.cwd,
		scopeKey,
		persistent: false,
		hasResumeHandle: false,
	});
	let agent: SDKAgent;
	try {
		const createAgent = params.createAgent ?? (await loadCursorSdk()).Agent.create;
		agent = await createAgent({
			apiKey: params.apiKey,
			model: params.modelSelection,
			mode: params.agentMode,
			local: buildCursorLocalAgentOptions({
				cwd: params.cwd,
				settingSources: params.settingSources,
				localSafety: params.localSafety,
				store: sessionStore.store,
			}),
			...(params.builtInTools !== undefined ? { tools: params.builtInTools } : {}),
		});
	} catch (error) {
		await sessionStore.dispose().catch(() => undefined);
		throw error;
	}
	let disposed: Promise<void> | undefined;
	return {
		scopeKey,
		poolKey: scopeKey,
		instanceId: 0,
		agent,
		store: sessionStore.store,
		storeIdentity: sessionStore.identity,
		sendState: createInitialSendState(),
		created: true,
		oneShot: true,
		commitSend: () => {},
		trackRunCompletion: () => {},
		dispose: () => {
			disposed ??= (async () => {
				try {
					await agent[Symbol.asyncDispose]?.();
				} finally {
					await sessionStore.dispose();
				}
			})().catch(() => undefined);
			return disposed;
		},
	};
}

/**
 * Lease the scope's pooled conversation agent. A request whose pool key differs from an
 * entry that is still being created or running a turn gets a one-shot agent instead:
 * tearing that entry down would kill the conversation's turn in flight (a title or
 * advisor request racing the first prompt). A `ready` entry with a different key is
 * replaced, which is the between-turns model, effort or provider-session switch.
 */
export async function acquireSessionCursorAgent(
	params: SessionCursorAgentCreateParams,
): Promise<SessionCursorAgentLease | OneShotCursorAgentLease> {
	const requestedScopeKey = getCursorSessionScopeKey();
	const scopeKey = getAcquireScopeKey(requestedScopeKey);
	const entryKey = sessionAgentEntryKey(scopeKey, params.conversationId);
	const persistentStore = getCursorSessionFile() !== undefined && params.mainConversation !== false;

	while (true) {
		if (scopeKey === requestedScopeKey) {
			assertScopeAcceptsAcquire(scopeKey);
		}
		if (invalidatedScopeKeys.has(entryKey)) {
			await disposePoolEntryForKey(entryKey);
		}

		const poolKey = buildSessionAgentPoolKey(scopeKey, params);
		const state = getSessionCursorAgentPoolState(entryKey);

		if (state.status === "ready" && state.poolKey !== poolKey) {
			await disposePoolEntryForKey(entryKey);
			continue;
		}
		if ((state.status === "busy" || state.status === "creating") && state.poolKey !== poolKey) {
			return createOneShotCursorAgent(params);
		}

		if (state.status === "ready") {
			return leaseFromEntry(state, entryKey, params, false);
		}

		if (state.status === "busy") {
			const busyGeneration = state.busyGeneration;
			await state.pendingCompletion;
			if (busyGeneration !== getScopeCreationGeneration(entryKey)) continue;
			continue;
		}

		if (state.status === "creating") {
			try {
				await state.creating;
			} catch (error) {
				if (error instanceof SessionCursorAgentCreationSupersededError) {
					assertScopeAcceptsAcquire(scopeKey);
					rethrowSupersededWhenReplacedByDifferentPoolKey(entryKey, poolKey, error);
					continue;
				}
				throw error;
			}
			continue;
		}

		assertScopeAcceptsAcquire(scopeKey);
		const creationGeneration = getScopeCreationGeneration(entryKey);
		const instanceId = allocateSessionAgentInstanceId();
		const sendState = createInitialSendState();
		let placeholder: SessionCursorAgentCreatingEntry;
		const creating = createSessionAgentEntry(scopeKey, entryKey, persistentStore, instanceId, sendState, params).then(async (createdEntry) => {
			const stillCurrent =
				sessionAgentsByScope.get(entryKey) === placeholder &&
				getScopeCreationGeneration(entryKey) === placeholder.creationGeneration;
			if (!stillCurrent) {
				await disposePoolEntry(createdEntry);
				if (sessionAgentsByScope.get(entryKey) === placeholder) {
					sessionAgentsByScope.delete(entryKey);
				}
				throw new SessionCursorAgentCreationSupersededError();
			}
			sessionAgentsByScope.set(entryKey, createdEntry);
			return createdEntry;
		});
		placeholder = {
			status: "creating",
			poolKey,
			instanceId,
			scopeKey: entryKey,
			sendState,
			creationGeneration,
			creating,
		};
		sessionAgentsByScope.set(entryKey, placeholder);

		try {
			const createdEntry = await creating;
			const lease = await tryLeaseReadyEntry(createdEntry, scopeKey, entryKey, params, poolKey, true);
			if (lease) return lease;
			continue;
		} catch (error) {
			if (sessionAgentsByScope.get(entryKey) === placeholder) {
				sessionAgentsByScope.delete(entryKey);
			}
			if (error instanceof SessionCursorAgentCreationSupersededError) {
				assertScopeAcceptsAcquire(scopeKey);
				rethrowSupersededWhenReplacedByDifferentPoolKey(entryKey, poolKey, error);
				continue;
			}
			throw error;
		}
	}
}

export type RefreshSessionCursorAgentConfigResult = "reloaded" | "no-agent" | "busy" | "unsupported";

/** Reload filesystem config in every pooled conversation agent of the scope. */
export async function refreshSessionCursorAgentConfig(scopeKey: string = getCursorSessionScopeKey()): Promise<RefreshSessionCursorAgentConfigResult> {
	const entries = [...sessionAgentsByScope.entries()]
		.filter(([entryKey, entry]) => isEntryOfScope(entryKey, scopeKey) && entry.status !== "creating")
		.map(([, entry]) => entry);
	if (entries.length === 0) return "no-agent";
	if (entries.some((entry) => entry.status === "busy")) return "busy";
	const ready = entries.filter((entry): entry is SessionCursorAgentReadyEntry => entry.status === "ready");
	if (ready.some((entry) => typeof entry.agent.reload !== "function")) return "unsupported";
	await Promise.all(ready.map((entry) => entry.agent.reload!()));
	return "reloaded";
}

export async function resetSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	await disposePoolEntryForScope(scopeKey);
}

export async function disposeSessionCursorAgent(scopeKey: string = getCursorSessionScopeKey()): Promise<void> {
	const background = `${scopeKey}::background`;
	if (backgroundScopeKeys.delete(background)) {
		await disposePoolEntryForScope(background, { terminal: true });
	}
	await disposePoolEntryForScope(scopeKey, { terminal: true });
}

/**
 * A new main conversation in the scope (`/fresh`, whose advisors move to new ids with it)
 * leaves the scope's other conversation agents unused until scope teardown. Dispose the
 * previous main conversation's entry and every idle entry of another conversation; busy
 * entries (an advisor run in flight) stay. The entries leave the pool before this returns
 * its promise.
 */
export async function disposeSupersededSessionConversations(
	mainConversationId: string,
	previousMainConversationId: string,
	scopeKey: string = getCursorSessionScopeKey(),
): Promise<void> {
	const mainEntryKey = sessionAgentEntryKey(scopeKey, mainConversationId);
	const previousEntryKey = sessionAgentEntryKey(scopeKey, previousMainConversationId);
	const superseded = [...sessionAgentsByScope.entries()]
		.filter(([entryKey, entry]) =>
			entryKey !== mainEntryKey &&
			isEntryOfScope(entryKey, scopeKey) &&
			(entryKey === previousEntryKey || entry.status === "ready"))
		.map(([entryKey]) => entryKey);
	await Promise.all(superseded.map((entryKey) => disposePoolEntryForKey(entryKey)));
}

export async function disposeAllSessionCursorAgents(): Promise<void> {
	const scopeKeys = [...new Set([...sessionAgentsByScope.keys(), ...terminalDisposedScopeGenerations.keys()])];
	await Promise.all(scopeKeys.map((scopeKey) => disposePoolEntryForScope(scopeKey, { terminal: true })));
	invalidatedScopeKeys.clear();
	deadTransportScopeKeys.clear();
	terminalDisposedScopeGenerations.clear();
}

export const __testUtils = {
	sessionAgentsByScope,
	sessionAgentEntryKey,
	getSessionCursorAgentPoolState,
	invalidateSessionAgent,
	disposeSessionCursorAgent,
	resetSessionCursorAgent,
	refreshSessionCursorAgentConfig,
	disposeAllSessionCursorAgents,
	buildApiKeyPoolKeyFingerprint,
	buildSessionAgentPoolKey,
	setDeadTransportAgentDisposeTimeoutMs(ms: number): number {
		const previous = deadTransportAgentDisposeTimeoutMs;
		deadTransportAgentDisposeTimeoutMs = ms;
		return previous;
	},
	SessionCursorAgentCreationSupersededError,
	SessionCursorAgentScopeClosedError,
};
