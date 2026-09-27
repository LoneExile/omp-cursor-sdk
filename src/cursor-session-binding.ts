import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

/**
 * One registration of this extension: the omp session its factory call serves.
 *
 * omp imports the extension module once per root session (the legacy loader imports with
 * a fresh `?mtime` tag, pi-coding-agent extensibility/plugins/legacy-pi-compat.ts
 * loadLegacyPiModule) and re-runs the same module's factory for every in-process
 * subagent, `/tan` clone and revived worker: they re-bind the parent's prepared factories
 * to their own ExtensionAPI "without evaluating the same module graph again" (sdk.ts
 * preloadedPreparedExtensions, extensibility/extensions/loader.ts bindPreparedExtensions).
 * Each bind has its own handler map and runner, so events never cross sessions, but
 * module-level state would. Per-session state therefore lives in slots of the binding,
 * and every event handler, command and tool of a registration runs inside it.
 *
 * Subagents and revived workers emit session_start (task/executor.ts,
 * task/persisted-revive.ts); `/tan` clones never do (modes/controllers/
 * tan-command-controller.ts creates the clone and prompts it). A binding without
 * session_start starts from its first prompt instead (bindCursorExtensionApi).
 *
 * Isolated subagents (task.isolation.enabled) and ACP sessions load a new module instance
 * instead (loader.ts importExtensionModule; loadLegacyPiModule tags the whole relative
 * graph with a fresh `?mtime`), and every instance registers the process-global
 * `cursor-sdk` api (pi-ai api-registry.ts registerCustomApi keeps the newest), so the
 * newest instance's provider receives every session's calls. Bindings are therefore
 * registered process-wide (processRegistry), and each call runs in the instance that owns
 * its session (`stream`).
 */
export interface CursorSessionBinding {
	readonly id: number;
	readonly slots: Map<symbol, unknown>;
	/** The owning module instance's provider entry for a request of this session. */
	readonly stream?: CursorSessionStream;
	/** First registration of its module instance: that instance's top-level session. */
	readonly root: boolean;
	/** sessionManager session id from this binding's latest session_start. */
	sessionId?: string;
	/** `ctx.agent.kind` from session_start: "sub" for subagents, `/tan` clones and workers. */
	agentKind?: "main" | "sub";
	/** The host emitted session_start for this binding's session. */
	sawSessionStart: boolean;
	/**
	 * A binding without session_start that is running a prompt and has not learned its
	 * provider state store yet: its first main-loop request is still unidentified.
	 */
	pendingClaim: boolean;
	/** That prompt's text (before_agent_start), to tell two pending bindings apart. */
	pendingPrompt?: string;
	/** Some provider state store maps to this binding. */
	learnedStore: boolean;
	closed: boolean;
}

/**
 * How a provider call found its session: by its provider state store, by its provider
 * session id, as the first request of a `/tan` clone's pending prompt, or by falling back
 * to the root session (`contested` when a clone is pending: the request might be the
 * clone's). `unknown`: no session can be told, so the call runs one-shot.
 */
export type CursorRequestResolution =
	| { via: "store" | "id" | "pending"; binding: CursorSessionBinding }
	| { via: "fallback"; binding: CursorSessionBinding; contested: boolean }
	| { via: "unknown"; binding?: undefined };

export type CursorSessionStream = (
	resolution: CursorRequestResolution,
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface CursorProcessSessionRegistry {
	/** Live bindings of every module instance in the process, in creation order. */
	readonly live: Set<CursorSessionBinding>;
	/**
	 * omp hands every provider call of one AgentSession its `providerSessionState` Map
	 * (agent-session.ts `#providerSessionState`, one per session; advisors share it), so the
	 * Map identifies the session of a request once one of its calls was matched.
	 */
	byProviderState: WeakMap<object, CursorSessionBinding>;
	nextBindingId: number;
}

// Shared by every module instance of this plugin in the process; bump the key when its
// shape changes.
const PROCESS_REGISTRY_KEY = Symbol.for("omp-cursor-sdk.session-bindings.v1");
const processRegistry = ((globalThis as Record<symbol, unknown>)[PROCESS_REGISTRY_KEY] ??= {
	live: new Set(),
	byProviderState: new WeakMap(),
	nextBindingId: 0,
} satisfies CursorProcessSessionRegistry) as CursorProcessSessionRegistry;
const liveBindings = processRegistry.live;

const storage = new AsyncLocalStorage<CursorSessionBinding>();

function makeBinding(options: { stream?: CursorSessionStream; root?: boolean } = {}): CursorSessionBinding {
	return {
		id: processRegistry.nextBindingId++,
		slots: new Map(),
		stream: options.stream,
		root: options.root === true,
		sawSessionStart: false,
		pendingClaim: false,
		learnedStore: false,
		closed: false,
	};
}

/** State outside any registration: tests and module load. */
let defaultBinding = makeBinding();
/** First registration in this module instance: the root session (the others re-bind it). */
let rootBinding: CursorSessionBinding | undefined;

/** A registration's binding; `stream` runs a request of its session in this module instance. */
export function createCursorSessionBinding(stream?: CursorSessionStream): CursorSessionBinding {
	const binding = makeBinding({ stream, root: rootBinding === undefined });
	liveBindings.add(binding);
	rootBinding ??= binding;
	return binding;
}

/** A binding outside every session, for one request that no session can be told for. */
export function createDetachedCursorSessionBinding(): CursorSessionBinding {
	return makeBinding();
}

export function currentCursorSessionBinding(): CursorSessionBinding {
	return storage.getStore() ?? rootBinding ?? defaultBinding;
}

export function runInCursorSessionBinding<T>(binding: CursorSessionBinding, body: () => T): T {
	return storage.run(binding, body);
}

export function markCursorSessionBindingStarted(
	binding: CursorSessionBinding,
	sessionId: string | undefined,
	agentKind: "main" | "sub" | undefined,
): void {
	binding.sessionId = sessionId;
	binding.agentKind = agentKind;
	binding.closed = false;
	liveBindings.add(binding);
}

/**
 * before_agent_start of a binding that never saw session_start: omp gives a `/tan` clone
 * a provider session id of its own (`<parent>:tan:<id>`) and a fresh provider state store,
 * so its first main-loop request matches no binding. Mark the binding as expecting it.
 */
export function armCursorSessionBindingClaim(binding: CursorSessionBinding, prompt: string | undefined): void {
	if (binding.sawSessionStart || binding.learnedStore || binding.closed) return;
	binding.pendingClaim = true;
	binding.pendingPrompt = prompt;
}

export function markCursorSessionBindingClosed(binding: CursorSessionBinding): void {
	binding.closed = true;
	liveBindings.delete(binding);
}

/** tan-command-controller.ts: `providerSessionId: \`${parentSessionId}:tan:${Snowflake.next()}\``. */
const TAN_CLONE_SESSION_MARKER = ":tan:";

function lastUserMessageText(context: Pick<Context, "messages"> | undefined): string {
	const messages = context?.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	}
	return "";
}

/** The pending `/tan` clone a clone request belongs to, if exactly one can be told. */
function resolvePendingClaim(context: Pick<Context, "messages"> | undefined): CursorSessionBinding | undefined {
	const pending = [...liveBindings].filter((binding) => binding.pendingClaim);
	if (pending.length <= 1) return pending[0];
	// Several clones prompted at once: the request's own prompt is its last user message.
	const text = lastUserMessageText(context);
	const matching = pending.filter((binding) => binding.pendingPrompt && text.includes(binding.pendingPrompt));
	return matching.length === 1 ? matching[0] : undefined;
}

/**
 * The session a provider call belongs to, among the live sessions of every module
 * instance. The host's shared model registry serves every session through whichever
 * registration registered the provider last (a subagent's createAgentSession clears and
 * re-registers the extension's sources, sdk.ts clearSourceRegistrations; pi-ai
 * api-registry.ts registerCustomApi keeps one entry per api), so the call itself must say
 * which session sent it: its provider state store, else its provider session id (a loop
 * turn's `options.sessionId` is its session's id, AgentSession.sessionId). A `/tan`
 * clone's request carries neither of a known session and goes to the clone whose prompt
 * is pending, or runs one-shot when that is ambiguous. Everything else falls back to the
 * top-level session (requests without either, such as the session title or the auto-learn
 * capture of the root session), and runs one-shot when that session or the one its store
 * belongs to has shut down.
 */
export function resolveCursorRequestBinding(
	options?: Pick<SimpleStreamOptions, "sessionId" | "providerSessionState">,
	context?: Pick<Context, "messages">,
): CursorRequestResolution {
	const providerState = options?.providerSessionState;
	if (providerState) {
		const known = processRegistry.byProviderState.get(providerState);
		// A closed session's store (a late call after its shutdown) is never reused.
		if (known) return known.closed ? { via: "unknown" } : { via: "store", binding: known };
	}
	const sessionId = options?.sessionId;
	if (sessionId) {
		for (const binding of liveBindings) {
			if (binding.closed || binding.sessionId !== sessionId) continue;
			if (providerState) learnCursorProviderSessionState(binding, providerState);
			return { via: "id", binding };
		}
		// Never the root session's own request: the clone's, or no one's.
		if (sessionId.includes(TAN_CLONE_SESSION_MARKER)) {
			const clone = providerState ? resolvePendingClaim(context) : undefined;
			return clone ? { via: "pending", binding: clone } : { via: "unknown" };
		}
	}
	// The top-level session: of the live instance roots, a main session before an isolated
	// subagent's. None left: the call belongs to no live session.
	const roots = [...liveBindings].filter((binding) => binding.root);
	const root = roots.find((binding) => binding.agentKind !== "sub") ?? roots[0];
	if (!root) return { via: "unknown" };
	const contested = [...liveBindings].some((binding) => binding !== root && binding.pendingClaim);
	return { via: "fallback", binding: root, contested };
}

/** Record the provider state store of a request the binding claimed as its own conversation. */
export function learnCursorProviderSessionState(binding: CursorSessionBinding, providerState: object | undefined): void {
	if (!providerState) return;
	processRegistry.byProviderState.set(providerState, binding);
	binding.learnedStore = true;
	binding.pendingClaim = false;
	binding.pendingPrompt = undefined;
}

export interface CursorSessionSlot<T> {
	get(): T;
	reset(): void;
}

/** Per-session state: each binding gets its own value, created on first use. */
export function cursorSessionSlot<T>(init: () => T): CursorSessionSlot<T> {
	const key = Symbol("cursor-session-slot");
	return {
		get(): T {
			const binding = currentCursorSessionBinding();
			if (!binding.slots.has(key)) binding.slots.set(key, init());
			return binding.slots.get(key) as T;
		},
		reset(): void {
			currentCursorSessionBinding().slots.set(key, init());
		},
	};
}

/**
 * An object view of a slot: property reads and writes go to the current binding's value,
 * so a module can keep its `state.field` code while the state is per session.
 */
export function cursorSessionSlotView<T extends object>(slot: CursorSessionSlot<T>): T {
	return new Proxy({} as T, {
		get: (_target, property) => Reflect.get(slot.get(), property),
		set: (_target, property, value) => Reflect.set(slot.get(), property, value),
		has: (_target, property) => Reflect.has(slot.get(), property),
		ownKeys: () => Reflect.ownKeys(slot.get()),
		getOwnPropertyDescriptor: (_target, property) => {
			const descriptor = Reflect.getOwnPropertyDescriptor(slot.get(), property);
			return descriptor ? { ...descriptor, configurable: true } : undefined;
		},
	});
}

/** A Set or Map whose contents are per session (methods act on the current binding's collection). */
export function cursorSessionCollection<C extends Set<unknown> | Map<unknown, unknown>>(init: () => C): C {
	const slot = cursorSessionSlot(init);
	return new Proxy(init(), {
		get: (_target, property) => {
			const collection = slot.get();
			const value = Reflect.get(collection, property, collection);
			return typeof value === "function" ? value.bind(collection) : value;
		},
	});
}

type AnyHandler = (...args: never[]) => unknown;

/**
 * The ExtensionAPI of one registration with every callback the host invokes later (event
 * handlers, commands, shortcuts, tool executions) running inside the binding.
 *
 * session_start handlers also run on session_switch: omp replaces the session in place for
 * /new, /fork and /resume and emits session_switch after the switch (agent-session.ts
 * newSession, fork, switchSession), where Pi emitted session_start again.
 *
 * A binding the host never sends session_start (a `/tan` clone) runs its session_start
 * handlers once, with its first prompt's context, before that prompt's before_agent_start
 * handlers: the clone gets its own scope (session file, cwd), resume and lineage state
 * instead of sharing an anonymous scope with every other such binding.
 */
export function bindCursorExtensionApi<T extends object>(pi: T, binding: CursorSessionBinding): T {
	const inBinding = <F extends AnyHandler>(handler: F): F =>
		((...args: Parameters<F>) => runInCursorSessionBinding(binding, () => handler(...args))) as F;
	const sessionStartHandlers: AnyHandler[] = [];
	let startedFromPrompt = false;
	// The host runs before_agent_start handlers one at a time (runner.ts emitBeforeAgentStart),
	// so the first one runs the start; a failing handler surfaces as that handler's error.
	const startFromPrompt = async (ctx: never): Promise<void> => {
		if (binding.sawSessionStart || startedFromPrompt) return;
		startedFromPrompt = true;
		for (const handler of sessionStartHandlers) await handler({ type: "session_start" } as never, ctx);
	};
	const onEvent = (target: Record<string, unknown>, event: string, handler: AnyHandler): void =>
		(target.on as (event: string, handler: AnyHandler) => void)(event, handler);
	const wrappers: Record<string, (target: Record<string, unknown>) => unknown> = {
		on: (target) => (event: string, handler: AnyHandler) => {
			const bound = inBinding(handler);
			if (event === "session_start") {
				sessionStartHandlers.push(bound);
				const onSessionStart = (...args: never[]) => {
					binding.sawSessionStart = true;
					binding.pendingClaim = false;
					return bound(...args);
				};
				onEvent(target, "session_start", onSessionStart);
				onEvent(target, "session_switch", onSessionStart);
				return;
			}
			if (event === "before_agent_start") {
				onEvent(target, event, async (...args: never[]) => {
					await startFromPrompt(args[1]);
					return bound(...args);
				});
				return;
			}
			onEvent(target, event, bound);
		},
		registerCommand: (target) => (name: string, options: { handler: AnyHandler }) =>
			(target.registerCommand as (name: string, options: unknown) => void)(name, {
				...options,
				handler: inBinding(options.handler),
			}),
		registerShortcut: (target) => (shortcut: unknown, options: { handler: AnyHandler }) =>
			(target.registerShortcut as (shortcut: unknown, options: unknown) => void)(shortcut, {
				...options,
				handler: inBinding(options.handler),
			}),
		registerTool: (target) => (tool: { execute?: AnyHandler }) =>
			(target.registerTool as (tool: unknown) => void)(
				typeof tool.execute === "function" ? { ...tool, execute: inBinding(tool.execute) } : tool,
			),
	};
	return new Proxy(pi, {
		get(target, property) {
			const wrap = typeof property === "string" ? wrappers[property] : undefined;
			if (wrap && typeof Reflect.get(target, property) === "function") return wrap(target as Record<string, unknown>);
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export const __testUtils = {
	/** Resets the process-wide registry and this module instance's own bindings. */
	reset(): void {
		liveBindings.clear();
		processRegistry.byProviderState = new WeakMap();
		processRegistry.nextBindingId = 0;
		defaultBinding = makeBinding();
		rootBinding = undefined;
	},
	liveBindingCount: () => liveBindings.size,
};
