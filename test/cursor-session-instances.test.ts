import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cursorExtension from "../src/index.js";
import * as providerA from "../src/cursor-provider.js";
import * as bindingA from "../src/cursor-session-binding.js";
import * as conversationA from "../src/cursor-one-shot-request.js";
import { disposeAllSessionCursorAgents } from "../src/cursor-session-agent.js";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { importModuleInstance } from "./helpers/module-instance.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";

// A second module instance, as omp loads one for an isolated subagent or an ACP session.
const secondExtension = (await importModuleInstance<{ default: typeof cursorExtension }>("src/index.ts", 2)).default;
const providerB = await importModuleInstance<typeof providerA>("src/cursor-provider.ts", 2);
const bindingB = await importModuleInstance<typeof bindingA>("src/cursor-session-binding.ts", 2);
const conversationB = await importModuleInstance<typeof conversationA>("src/cursor-one-shot-request.ts", 2);

const PARENT = { id: "01a0e2f1-0000-7000-8000-00000000a001", file: "/tmp/sessions/parent.jsonl" };
const CHILD = { id: "01a0e2f1-0000-7000-8000-00000000c001", file: "/tmp/sessions/parent/0-Task.jsonl" };

const model = {
	id: "composer-2.5",
	name: "Composer 2.5",
	api: "cursor-sdk",
	provider: "cursor-sdk",
	baseUrl: "https://cursor.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
} as unknown as Model;
type ProviderSessionState = NonNullable<SimpleStreamOptions["providerSessionState"]>;
const loopTurn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };

async function registerSession(extension: typeof cursorExtension, session: { id: string; file: string }, kind: "main" | "sub") {
	const pi = createExtensionPi([createTestToolInfo("custom_read")]);
	await extension(pi);
	await pi.runSessionStart({
		cwd: "/tmp/project",
		agent: { kind, id: kind === "main" ? "Main" : "0-Task", name: kind === "main" ? "main" : "task", depth: kind === "main" ? 0 : 1 },
		sessionManager: {
			getSessionId: () => session.id,
			getSessionFile: () => session.file,
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
	} as never);
	return { pi, providerSessionState: new Map() as ProviderSessionState };
}

/** Send a main-loop request and let it end: classification happens before the aborted turn stops. */
async function send(stream: typeof providerA.streamCursor, session: { id: string }, providerSessionState: ProviderSessionState) {
	const controller = new AbortController();
	controller.abort();
	const events: AssistantMessageEventStream = stream(model, loopTurn, { sessionId: session.id, providerSessionState, signal: controller.signal });
	for await (const _event of events) {
		// drain
	}
}

/** The main conversation each instance's tracker holds for a session. */
function mainConversationSeenBy(session: { id: string }, providerSessionState: ProviderSessionState) {
	const binding = bindingA.resolveCursorRequestBinding({ sessionId: session.id, providerSessionState }).binding!;
	return {
		a: bindingA.runInCursorSessionBinding(binding, () => conversationA.__testUtils.mainConversation()),
		b: bindingB.runInCursorSessionBinding(binding, () => conversationB.__testUtils.mainConversation()),
	};
}

describe("sessions of several module instances in one process", () => {
	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingA.__testUtils.reset();
		bindingB.__testUtils.reset();
		await resetIndexExtensionTestState();
	});

	afterEach(async () => {
		await disposeAllSessionCursorAgents();
		bindingA.__testUtils.reset();
		bindingB.__testUtils.reset();
	});

	it("runs each session's calls in the instance that owns it, whichever instance's provider receives them", async () => {
		const parent = await registerSession(cursorExtension, PARENT, "main");
		const child = await registerSession(secondExtension, CHILD, "sub");

		// The child's instance registered the `cursor-sdk` api last, so its provider gets the parent's turn.
		await send(providerB.streamCursor, PARENT, parent.providerSessionState);
		expect(mainConversationSeenBy(PARENT, parent.providerSessionState)).toEqual({
			a: { id: PARENT.id, providerState: parent.providerSessionState },
			b: { id: undefined, providerState: undefined },
		});

		await send(providerA.streamCursor, CHILD, child.providerSessionState);
		expect(mainConversationSeenBy(CHILD, child.providerSessionState)).toEqual({
			a: { id: undefined, providerState: undefined },
			b: { id: CHILD.id, providerState: child.providerSessionState },
		});
	});

	it("never reuses a session that shut down: its late calls and the fallback run one-shot", async () => {
		const parent = await registerSession(cursorExtension, PARENT, "main");
		const child = await registerSession(secondExtension, CHILD, "sub");
		// The parent's first call taught its store.
		expect(bindingB.resolveCursorRequestBinding({ sessionId: PARENT.id, providerSessionState: parent.providerSessionState }).via).toBe("id");
		const parentBinding = bindingA.resolveCursorRequestBinding({ providerSessionState: parent.providerSessionState }).binding!;

		await parent.pi.runSessionShutdown();
		expect(bindingB.resolveCursorRequestBinding({ sessionId: PARENT.id, providerSessionState: parent.providerSessionState })).toEqual({ via: "unknown" });
		await send(providerB.streamCursor, PARENT, parent.providerSessionState);
		expect(bindingA.runInCursorSessionBinding(parentBinding, () => conversationA.__testUtils.mainConversation()).providerState).toBeUndefined();

		// A title request of the still-running child falls back to the child's session.
		expect(bindingA.resolveCursorRequestBinding({ sessionId: "01a0e2f1-0000-7000-8000-00000000beef" }).binding).toBe(
			bindingB.resolveCursorRequestBinding({ sessionId: CHILD.id, providerSessionState: child.providerSessionState }).binding,
		);
		await child.pi.runSessionShutdown();
		expect(bindingA.resolveCursorRequestBinding({ sessionId: "01a0e2f1-0000-7000-8000-00000000beef" })).toEqual({ via: "unknown" });
		expect(bindingB.resolveCursorRequestBinding({ sessionId: "01a0e2f1-0000-7000-8000-00000000beef" })).toEqual({ via: "unknown" });
	});
});
