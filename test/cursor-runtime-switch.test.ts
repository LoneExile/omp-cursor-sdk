import type { Context, Model } from "@oh-my-pi/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCursorProviderTurn, resolveCursorProviderTurnConfig } from "../src/cursor-provider-turn-prepare.js";
import { acquireSessionCursorAgent, disposeAllSessionCursorAgents } from "../src/cursor-session-agent.js";
import { planCursorSessionSend } from "../src/cursor-session-send-policy.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as sessionStoreTestUtils } from "../src/cursor-session-store.js";

sessionStoreTestUtils.setSdkOperations({
	getDefaultStateRoot: () => "/tmp/omp-cursor-sdk-test-state",
	openSqliteStore: async () => ({ dispose: async () => {} }) as never,
});

const model = { id: "composer-2.5", api: "cursor-sdk", provider: "cursor-sdk", reasoning: false } as unknown as Model;
const firstTurn: Context = { systemPrompt: ["omp system prompt"], messages: [{ role: "user", content: "Refactor the parser", timestamp: 1 }] };

function acquireLocal(agentId: string) {
	return acquireSessionCursorAgent({
		apiKey: "test-key",
		agentMode: "agent",
		cwd: "/tmp/project",
		modelSelection: { id: "composer-2.5" },
		createAgent: vi.fn().mockResolvedValue({ agentId, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) }) as never,
	});
}

describe("local → cloud → local runtime switch", () => {
	afterEach(async () => {
		delete process.env.PI_CURSOR_RUNTIME;
		await disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.reset();
	});

	it("rebootstraps the local agent after a cloud turn so it sees the cloud turns", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/runtime-switch.jsonl");
		const local = await acquireLocal("agent-local-1");
		local.commitSend(firstTurn, true);
		await local.trackRunCompletion(Promise.resolve());

		// A cloud turn for the same scope. It stops at its preflight here (no first-use
		// acknowledgement or repository), so no SDK call happens.
		process.env.PI_CURSOR_RUNTIME = "cloud";
		const resolvedConfig = resolveCursorProviderTurnConfig("/tmp/project");
		expect(resolvedConfig.runtime.value).toBe("cloud");
		const afterCloud: Context = {
			...firstTurn,
			messages: [...firstTurn.messages, { role: "user", content: "Run it in the cloud", timestamp: 2 }],
		};
		await expect(
			prepareCursorProviderTurn({
				params: { model, context: afterCloud, options: {}, stream: {} as never, partial: {} as never, sdkEventDebugRef: { current: undefined } } as never,
				cwd: "/tmp/project",
				resolvedApiKey: "test-key",
				sdkEventDebug: undefined,
				throwIfAborted: () => {},
				resolvedConfig,
			}),
		).rejects.toThrow("Cursor cloud runtime is not ready to start");
		delete process.env.PI_CURSOR_RUNTIME;

		const next = await acquireLocal("agent-local-2");
		expect(next.agent.agentId).toBe("agent-local-2");
		expect(planCursorSessionSend(next.sendState, afterCloud)).toMatchObject({ mode: "bootstrap" });
	});
});
