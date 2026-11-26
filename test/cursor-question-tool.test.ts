import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	CURSOR_ASK_QUESTION_BLOCKED_EVENT,
	CURSOR_ASK_QUESTION_ENV,
	CURSOR_ASK_QUESTION_TOOL_NAME,
	registerCursorQuestionTool,
} from "../src/cursor-question-tool.js";
import { createExtensionTestContext } from "./helpers/context-fixtures.js";
import { createPiHarness } from "./helpers/pi-registration-harness.js";
import { getHarnessRegisteredTool } from "./helpers/tool-fixtures.js";

type DialogOptions = { signal?: AbortSignal } | undefined;

// Promise.withResolvers is outside this repo's test tsconfig lib.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function setup(ui: Partial<ExtensionContext["ui"]>) {
	const pi = createPiHarness();
	registerCursorQuestionTool(pi);
	const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ASK_QUESTION_TOOL_NAME);
	const ctx = createExtensionTestContext({ hasUI: true, ui });
	const run = (params: unknown, signal?: AbortSignal) => tool.execute("call-1", params as never, signal, undefined, ctx);
	return { pi, run };
}

describe("cursor_ask_question dialogs", () => {
	let previousEnv: string | undefined;
	beforeEach(() => {
		previousEnv = process.env[CURSOR_ASK_QUESTION_ENV];
		delete process.env[CURSOR_ASK_QUESTION_ENV];
	});
	afterEach(() => {
		if (previousEnv === undefined) delete process.env[CURSOR_ASK_QUESTION_ENV];
		else process.env[CURSOR_ASK_QUESTION_ENV] = previousEnv;
	});

	it("passes the tool's abort signal to the open dialog, records the question cancelled and asks no later question", async () => {
		const opened = deferred<DialogOptions>();
		// omp's dialog contract: an open dialog settles undefined when its signal aborts.
		const select = vi.fn((_title: string, _options: unknown, options: DialogOptions) => {
			const closed = deferred<string | undefined>();
			options?.signal?.addEventListener("abort", () => closed.resolve(undefined), { once: true });
			opened.resolve(options);
			return closed.promise;
		});
		const input = vi.fn(async () => "never asked");
		const { pi, run } = setup({ select, input } as unknown as Partial<ExtensionContext["ui"]>);
		const controller = new AbortController();

		const result = run(
			{
				questions: [
					{ id: "first", question: "Pick one", options: ["A", "B"] },
					{ id: "second", question: "Anything else?" },
				],
			},
			controller.signal,
		);
		expect((await opened.promise)?.signal).toBe(controller.signal);
		controller.abort();

		const { content, details } = await result;
		expect(input).not.toHaveBeenCalled();
		expect(content).toEqual([{ type: "text", text: "User cancelled the question." }]);
		expect(details).toMatchObject({
			cancelled: true,
			answers: [{ id: "first", question: "Pick one", answer: null, wasCustom: false, cancelled: true }],
		});
		expect(pi._eventsEmitted.filter((event) => event.channel === CURSOR_ASK_QUESTION_BLOCKED_EVENT).map((event) => event.data)).toEqual([
			{ active: true },
			{ active: false },
		]);
	});

	it("selects an option named like the custom-answer entry instead of opening a text input", async () => {
		const select = vi.fn(async (_title: string, options: string[]) => {
			expect(options).toEqual(["Type a custom answer", "Other", "Type a custom answer (2)"]);
			return "Type a custom answer";
		});
		const input = vi.fn(async () => "typed");
		const { run } = setup({ select, input } as unknown as Partial<ExtensionContext["ui"]>);

		const { details } = await run({ question: "Which?", options: ["Type a custom answer", "Other"] });

		expect(input).not.toHaveBeenCalled();
		expect(details).toMatchObject({
			cancelled: false,
			answers: [{ answer: "Type a custom answer", value: "Type a custom answer", wasCustom: false, cancelled: false }],
		});
	});
});
