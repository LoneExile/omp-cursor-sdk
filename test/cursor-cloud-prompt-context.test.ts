import { Agent } from "@cursor/sdk";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { buildCursorPrompt } from "../src/context.js";
import { __testUtils as cloudLifecycleTestUtils, registerCursorCloudLifecycleLedger } from "../src/cursor-cloud-lifecycle.js";
import { resolveCursorSdkConfig, type CursorCloudContextHandoff } from "../src/cursor-config.js";
import { buildCursorCloudPromptContext, prepareCursorProviderTurn } from "../src/cursor-provider-turn-prepare.js";
import { CURSOR_CLOUD_ACK_DISCLOSURE } from "../src/cursor-runtime-state.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import {
	assistantReply,
	branchSummary,
	compactionSummary,
	expectInOrder,
	frameImage,
	history,
	hostMessages,
	imageHook,
	noteImage,
	noteImages,
	planNotice,
	prompt,
	promptImage,
	promptImages,
	shotImage,
	shotImages,
} from "./helpers/turn-input-fixtures.js";

const SCOPE = "/tmp/sessions/cloud-prompt-context.jsonl";
const CLOUD_AGENT_ID = "bc-00000000-0000-0000-0000-000000000001";
// The prompt budget is the model's window minus its output reserve (cursor-usage-accounting.ts).
const model = { id: "composer-2.5", api: "cursor-sdk", provider: "cursor-sdk", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 } as unknown as Model;
const tightModel = { ...model, contextWindow: 250, maxTokens: 50 } as unknown as Model;
const tightBudget = { maxInputTokens: 1, charsPerToken: 1 };

// One fileMention packs every `@…` of the turn; convertToLlm gives its text files a `developer`
// message and its image files one `user` message (`<file path>` lines plus the images).
const fileMention = {
	role: "fileMention",
	files: [{ path: "notes.md", content: "Use bun test." }, { path: "shot.png", content: "", image: shotImage }],
	timestamp: 3,
};

// agent-session.ts assembles a turn as [notices before the prompt, prompt, next-turn messages,
// @file mentions, before_agent_start messages].
const context: Context = {
	systemPrompt: ["Be helpful."],
	messages: hostMessages([...history, planNotice, prompt, fileMention, imageHook]),
};
const pendingSections = [
	"Developer: Plan mode is active.",
	"User: Fix the flaky test",
	'Developer: <file path="notes.md">\nUse bun test.\n</file>',
	'User: <file path="shot.png">\n</file>',
	"Developer: Attached by hook.",
	"User: Images attached to screenshot-note.",
];
const pendingImages = [...promptImages, ...shotImages, ...noteImages];

function withMessages(messages: unknown[]): Context {
	return { systemPrompt: ["Be helpful."], messages: hostMessages(messages) };
}

describe("buildCursorCloudPromptContext", () => {
	it("sends the whole pending input on the fresh handoff, not only the last user message", () => {
		const fresh = buildCursorCloudPromptContext(context, "fresh");

		expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "developer", "user", "developer", "user", "developer", "user"]);
		expect(fresh.messages).toEqual(context.messages.slice(2));
		expect(fresh.systemPrompt).toBe(context.systemPrompt);
		const sent = buildCursorPrompt(fresh);
		expectInOrder(sent.text, pendingSections);
		expect(sent.text).not.toContain("Refactor the parser");
		expect(sent.text).not.toContain("Parser refactored.");
	});

	it("keeps the real prompt text and its images when a synthetic image user message follows it", () => {
		const promptThenNote = withMessages([...history, prompt, imageHook]);

		expect(promptThenNote.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "Images attached to screenshot-note." }, noteImage] });
		const sent = buildCursorPrompt(buildCursorCloudPromptContext(promptThenNote, "fresh"));

		expectInOrder(sent.text, ["User: Fix the flaky test", "Developer: Attached by hook.", "User: Images attached to screenshot-note."]);
		expect(sent.images).toEqual([...promptImages, ...noteImages]);
	});

	it("sends an @file image after the prompt's own image", () => {
		const promptThenShot = withMessages([...history, prompt, { role: "fileMention", files: [{ path: "shot.png", content: "", image: shotImage }], timestamp: 3 }]);
		const sent = buildCursorPrompt(buildCursorCloudPromptContext(promptThenShot, "fresh"));

		expectInOrder(sent.text, ["User: Fix the flaky test", 'User: <file path="shot.png">\n</file>']);
		expect(sent.images).toEqual([...promptImages, ...shotImages]);
	});

	it("sends the images of every pending user message in order", () => {
		expect(buildCursorPrompt(buildCursorCloudPromptContext(context, "fresh")).images).toEqual(pendingImages);
	});

	it("sends `!` and Python output run since the last reply, never `!!` or `$$` output", () => {
		// Host convertToLlm: bashExecution/pythonExecution become `user` messages; `excludeFromContext` drops them.
		const ran = withMessages([
			...history,
			{ role: "bashExecution", command: "printf ok", output: "bash-output", exitCode: 0, timestamp: 3 },
			{ role: "bashExecution", command: "printf hidden", output: "bash-hidden-output", exitCode: 0, excludeFromContext: true, timestamp: 3 },
			{ role: "pythonExecution", code: "print('py')", output: "python-output", exitCode: 0, timestamp: 3 },
			{ role: "pythonExecution", code: "print('hidden')", output: "python-hidden-output", exitCode: 0, excludeFromContext: true, timestamp: 3 },
			{ role: "user", content: "Now inspect the result", timestamp: 4 },
		]);
		const fresh = buildCursorPrompt(buildCursorCloudPromptContext(ran, "fresh")).text;

		expectInOrder(fresh, ["bash-output", "python-output", "User: Now inspect the result"]);
		expect(fresh).not.toContain("hidden-output");
		expect(fresh).not.toContain("Refactor the parser");
		expect(buildCursorPrompt(buildCursorCloudPromptContext(ran, "bootstrap")).text).not.toContain("hidden-output");
	});

	it("sends the latest prompt and its images again when a hook, not a prompt, started the turn", () => {
		const hookTurn = withMessages([
			{ role: "user", content: [{ type: "text", text: "Describe this image" }, promptImage], timestamp: 1 },
			assistantReply("It is a diagram.", 2),
			planNotice,
		]);
		const fresh = buildCursorCloudPromptContext(hookTurn, "fresh");

		expect(fresh.messages.map((message) => message.role)).toEqual(["user", "developer"]);
		const sent = buildCursorPrompt(fresh);
		expectInOrder(sent.text, ["User: Describe this image", "Developer: Plan mode is active."]);
		expect(sent.text).not.toContain("It is a diagram.");
		expect(sent.images).toEqual(promptImages);
	});

	it("sends the latest prompt but no tool result when a tool result started the turn", () => {
		const toolTurn: Context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "Describe this image" }, promptImage], timestamp: 1 },
				{ ...assistantReply("Reading the file.", 2), content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.png" } }], stopReason: "toolUse" },
				{ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "tool-output" }], isError: false, timestamp: 3 },
			],
		};
		const sent = buildCursorPrompt(buildCursorCloudPromptContext(toolTurn, "fresh"));

		expect(sent.text).toContain("User: Describe this image");
		expect(sent.text).not.toContain("tool-output");
		expect(sent.images).toEqual(promptImages);
	});

	it("keeps the whole pending input within a tight budget", () => {
		const sent = buildCursorPrompt(buildCursorCloudPromptContext(context, "fresh"), tightBudget);

		expectInOrder(sent.text, pendingSections);
		expect(sent.text).not.toContain("Earlier transcript omitted");
		expect(sent.images).toEqual(pendingImages);
	});

	it("keeps every message of a turn that has no assistant message yet", () => {
		const firstTurn = withMessages([{ role: "user", content: "First request", timestamp: 1 }, planNotice, { role: "user", content: "Second request", timestamp: 3 }]);

		expect(buildCursorCloudPromptContext(firstTurn, "fresh").messages).toEqual(firstTurn.messages);
	});

	it("sends a lone user prompt exactly as the whole context would", () => {
		const lone: Context = { systemPrompt: ["Be helpful."], messages: [{ role: "user", content: "Hello", timestamp: 1 }] };

		expect(buildCursorCloudPromptContext(lone, "fresh")).toEqual(lone);
		expect(buildCursorPrompt(buildCursorCloudPromptContext(lone, "fresh"))).toEqual(buildCursorPrompt(lone));
	});

	it("keeps the latest user message when nothing follows the last assistant message", () => {
		const answered = withMessages(history);

		expect(buildCursorCloudPromptContext(answered, "fresh").messages).toEqual([answered.messages[0]]);
	});

	it("sends this turn's request but no summary, on a context that follows a branch or compaction summary", () => {
		const afterTree = withMessages([
			...history,
			branchSummary,
			compactionSummary("Compacted. secret=XYZ", [frameImage]),
			{ role: "user", content: "Second request", timestamp: 4 },
		]);
		const fresh = buildCursorPrompt(buildCursorCloudPromptContext(afterTree, "fresh"));
		const bootstrap = buildCursorPrompt(buildCursorCloudPromptContext(afterTree, "bootstrap"));

		expect(fresh.text).toContain("User: Second request");
		expect(fresh.text).not.toContain("secret=XYZ");
		expect(fresh.images).toEqual([]);
		expect(bootstrap.text).toContain("User: Second request");
		expect(bootstrap.text).toContain("secret=XYZ");
		expect(buildCursorCloudPromptContext(afterTree, "never").messages).toEqual([afterTree.messages.at(-1)]);
	});

	it("replays the whole context on the bootstrap handoff", () => {
		expect(buildCursorCloudPromptContext(context, "bootstrap")).toBe(context);
		const text = buildCursorPrompt(buildCursorCloudPromptContext(context, "bootstrap")).text;
		expectInOrder(text, ["User: Refactor the parser", "Assistant: Parser refactored.", ...pendingSections]);
	});

	it("keeps only the latest user message on the never handoff, or the last message when there is none", () => {
		expect(buildCursorCloudPromptContext(context, "never").messages).toEqual([context.messages[7]]);
		const noUser = withMessages([planNotice]);
		expect(buildCursorCloudPromptContext(noUser, "never").messages).toEqual(noUser.messages);
	});
});

describe("Cursor Cloud prompt from the turn input", () => {
	let create: MockInstance<typeof Agent.create>;

	beforeEach(() => {
		// Max Mode would require the patched SDK; this suite only reads the prompt.
		process.env.PI_CURSOR_MAX_MODE = "0";
		cursorSessionScopeTestUtils.set("/tmp/project", SCOPE);
		cloudLifecycleTestUtils.reset();
		registerCursorCloudLifecycleLedger({ on: () => {}, appendEntry: () => {} } as never);
		cloudLifecycleTestUtils.setDurableWriter(() => true);
		create = vi.spyOn(Agent, "create").mockResolvedValue({ agentId: CLOUD_AGENT_ID, [Symbol.asyncDispose]: async () => {} } as never);
	});

	afterEach(() => {
		create.mockRestore();
		delete process.env.PI_CURSOR_MAX_MODE;
		cloudLifecycleTestUtils.reset();
		cursorSessionScopeTestUtils.reset();
	});

	async function prepareCloudTurn(contextHandoff: CursorCloudContextHandoff, options: { promptModel?: Model; promptContext?: Context } = {}) {
		const prepared = await prepareCursorProviderTurn({
			params: {
				model: options.promptModel ?? model,
				context: options.promptContext ?? context,
				options: {},
				stream: {} as never,
				partial: {} as never,
				sdkEventDebugRef: { current: undefined },
			} as never,
			cwd: "/tmp/project",
			resolvedApiKey: "test-key",
			sdkEventDebug: undefined,
			throwIfAborted: () => {},
			resolvedConfig: resolveCursorSdkConfig({
				env: {},
				builtIn: { runtime: "cloud", cloud: { contextHandoff, acknowledged: true, allowLocalState: true } },
			}),
		});
		await prepared.lifecycle.dispose();
		expect(create).toHaveBeenCalledTimes(1);
		return prepared.payload;
	}

	it("sends the notices, the real prompt text and every image of the pending input under the fresh handoff", async () => {
		const payload = await prepareCloudTurn("fresh");

		expectInOrder(payload.text, pendingSections);
		expect(payload.text).not.toContain("Refactor the parser");
		expect(payload.text).not.toContain("Parser refactored.");
		expect(payload.images).toEqual(pendingImages);
	});

	it("sends this turn's request but no summary under the fresh handoff, and the summary under bootstrap", async () => {
		const afterTree = withMessages([...history, branchSummary, { role: "user", content: "Second request", timestamp: 4 }]);

		const fresh = await prepareCloudTurn("fresh", { promptContext: afterTree });
		create.mockClear();
		const bootstrap = await prepareCloudTurn("bootstrap", { promptContext: afterTree });

		expect(fresh.text).toContain("User: Second request");
		expect(fresh.text).not.toContain("secret=XYZ");
		expect(bootstrap.text).toContain("secret=XYZ");
	});

	it("keeps sending the whole transcript under the bootstrap handoff", async () => {
		const payload = await prepareCloudTurn("bootstrap");

		expectInOrder(payload.text, ["User: Refactor the parser", "Assistant: Parser refactored.", ...pendingSections]);
		expect(payload.images).toEqual(pendingImages);
	});

	it("never trims the pending input under the bootstrap handoff when the budget leaves no room for older history", async () => {
		const payload = await prepareCloudTurn("bootstrap", { promptModel: tightModel });

		expectInOrder(payload.text, pendingSections);
		expect(payload.text).toContain("[Earlier transcript omitted: 2 messages to fit Cursor context budget]");
		expect(payload.text).not.toContain("Refactor the parser");
	});

	it("refuses a turn with nothing to send before any cloud agent exists", async () => {
		// Only a summary is left: `fresh` sends no summary, and a task-less cloud agent is billable and can push.
		const onlySummary = withMessages([branchSummary]);

		await expect(prepareCloudTurn("fresh", { promptContext: onlySummary })).rejects.toThrow("Cursor cloud runtime has nothing to send for this turn");
		expect(create).not.toHaveBeenCalled();
		// `bootstrap` can still send the summary, so it is not refused.
		const payload = await prepareCloudTurn("bootstrap", { promptContext: onlySummary });
		expect(payload.text).toContain("secret=XYZ");
	});
});

describe("Cursor Cloud consent text", () => {
	it("tells the user exactly what the default fresh context sends", () => {
		expect(CURSOR_CLOUD_ACK_DISCLOSURE).toContain(
			"Fresh context is used by default and sends only the input since the last assistant reply: your prompt and its attachments, ! and Python command output you ran since then, and the notices, @file contents and hook messages omp attaches. When a hook or a tool result, not a new prompt, started the turn, your latest prompt is sent again. Earlier conversation and summaries are sent only with explicit bootstrap opt-in.",
		);
	});
});
