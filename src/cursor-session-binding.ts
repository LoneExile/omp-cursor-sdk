import { AsyncLocalStorage } from "node:async_hooks";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";

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
 */
export interface CursorSessionBinding {
	readonly id: number;
	readonly slots: Map<symbol, unknown>;
	/** sessionManager session id from this binding's latest session_start. */
	sessionId?: string;
	/** `ctx.agent.kind` from session_start: "sub" for subagents, `/tan` clones and workers. */
	agentKind?: "main" | "sub";
	closed: boolean;
}

const storage = new AsyncLocalStorage<CursorSessionBinding>();
let nextBindingId = 0;

function makeBinding(): CursorSessionBinding {
	return { id: nextBindingId++, slots: new Map(), closed: false };
}

/** State outside any registration: tests and module load. */
let defaultBinding = makeBinding();
/** First registration in this module instance: the root session (the others re-bind it). */
let rootBinding: CursorSessionBinding | undefined;
const liveBindings = new Set<CursorSessionBinding>();
/**
 * omp hands every provider call of one AgentSession its `providerSessionState` Map
 * (agent-session.ts `#providerSessionState`, one per session; advisors share it), so the
 * Map identifies the session of a request once one of its calls was matched.
 */
const bindingsByProviderState = new WeakMap<object, CursorSessionBinding>();

export function createCursorSessionBinding(): CursorSessionBinding {
	const binding = makeBinding();
	liveBindings.add(binding);
	rootBinding ??= binding;
	return binding;
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

export function markCursorSessionBindingClosed(binding: CursorSessionBinding): void {
	binding.closed = true;
	liveBindings.delete(binding);
}

/**
 * The session a provider call belongs to. The host's shared model registry serves every
 * session through whichever registration registered the provider last (a subagent's
 * createAgentSession clears and re-registers the extension's sources, sdk.ts
 * clearSourceRegistrations; pi-ai api-registry.ts registerCustomApi keeps one entry per
 * api), so the call itself must say which session sent it: its provider state store,
 * else its provider session id (a loop turn's `options.sessionId` is its session's id,
 * AgentSession.sessionId), else the root session (requests without either, such as the
 * session title or the auto-learn capture of the root session).
 */
export function resolveCursorRequestBinding(
	options?: Pick<SimpleStreamOptions, "sessionId" | "providerSessionState">,
): CursorSessionBinding {
	const providerState = options?.providerSessionState;
	if (providerState) {
		const known = bindingsByProviderState.get(providerState);
		if (known && !known.closed) return known;
	}
	const sessionId = options?.sessionId;
	if (sessionId) {
		for (const binding of liveBindings) {
			if (binding.closed || binding.sessionId !== sessionId) continue;
			if (providerState) bindingsByProviderState.set(providerState, binding);
			return binding;
		}
	}
	if (rootBinding && !rootBinding.closed) return rootBinding;
	return currentCursorSessionBinding();
}

/** Record the provider state store of a request the binding claimed as its own conversation. */
export function learnCursorProviderSessionState(binding: CursorSessionBinding, providerState: object | undefined): void {
	if (providerState) bindingsByProviderState.set(providerState, binding);
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
 */
export function bindCursorExtensionApi<T extends object>(pi: T, binding: CursorSessionBinding): T {
	const inBinding = <F extends AnyHandler>(handler: F): F =>
		((...args: Parameters<F>) => runInCursorSessionBinding(binding, () => handler(...args))) as F;
	const wrappers: Record<string, (target: Record<string, unknown>) => unknown> = {
		on: (target) => (event: string, handler: AnyHandler) =>
			(target.on as (event: string, handler: AnyHandler) => void)(event, inBinding(handler)),
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
	reset(): void {
		defaultBinding = makeBinding();
		rootBinding = undefined;
		liveBindings.clear();
	},
	liveBindingCount: () => liveBindings.size,
};
