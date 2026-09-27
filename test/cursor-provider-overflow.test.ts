import { describe, expect, it } from "vitest";
import {
	CURSOR_OVERFLOW_MARKER,
	normalizeCursorOverflowErrorMessage,
	rewriteCursorOverflowAssistantMessage,
	registerCursorOverflowNormalization,
} from "../src/cursor-provider-overflow.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

function assistantError(provider: string | undefined, errorMessage?: string): AssistantMessage {
	return {
		...makeAssistantMessage(""),
		...(provider ? { provider } : {}),
		stopReason: "error",
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

describe("normalizeCursorOverflowErrorMessage", () => {
	it("rewrites explicit Cursor context-length failures to pi's overflow form", () => {
		expect(normalizeCursorOverflowErrorMessage("Your input exceeds the context window of this model")).toBe(
			`${CURSOR_OVERFLOW_MARKER}: Your input exceeds the context window of this model`,
		);
		expect(normalizeCursorOverflowErrorMessage("prompt is too long: 300000 tokens > 200000 maximum")).toBe(
			`${CURSOR_OVERFLOW_MARKER}: prompt is too long: 300000 tokens > 200000 maximum`,
		);
		expect(normalizeCursorOverflowErrorMessage("Input length exceeds the maximum context length")).toBe(
			`${CURSOR_OVERFLOW_MARKER}: Input length exceeds the maximum context length`,
		);
	});

	it("is idempotent and leaves already-normalized messages untouched", () => {
		const already = `${CURSOR_OVERFLOW_MARKER}: prompt is too long`;
		expect(normalizeCursorOverflowErrorMessage(already)).toBeUndefined();
	});

	it("never reclassifies throttling/rate-limit signals as overflow", () => {
		expect(normalizeCursorOverflowErrorMessage("Too many requests, retry after 30s")).toBeUndefined();
		expect(normalizeCursorOverflowErrorMessage("rate limited by upstream")).toBeUndefined();
		expect(normalizeCursorOverflowErrorMessage("throttlingException: slow down")).toBeUndefined();
	});

	it("returns undefined for non-overflow messages (auth/network/generic)", () => {
		expect(normalizeCursorOverflowErrorMessage("Cursor SDK request failed because the API key may be invalid")).toBeUndefined();
		expect(normalizeCursorOverflowErrorMessage("Network error: Cursor SDK request failed")).toBeUndefined();
		expect(normalizeCursorOverflowErrorMessage("Cursor SDK run failed.")).toBeUndefined();
		expect(normalizeCursorOverflowErrorMessage(undefined)).toBeUndefined();
		expect(normalizeCursorOverflowErrorMessage("   ")).toBeUndefined();
	});
});

describe("rewriteCursorOverflowAssistantMessage", () => {
	it("rewrites a Cursor context-overflow error so pi auto-compacts", () => {
		const result = rewriteCursorOverflowAssistantMessage(
			assistantError("cursor-sdk", "prompt is too long for the model context window"),
			true,
		);
		expect(result).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: `${CURSOR_OVERFLOW_MARKER}: prompt is too long for the model context window`,
		});
	});

	it("leaves the message untouched when it is not from the Cursor provider", () => {
		expect(
			rewriteCursorOverflowAssistantMessage(
				assistantError("anthropic", "exceeds the context window"),
				false,
			),
		).toBeUndefined();
	});

	it("ignores Cursor non-error messages", () => {
		const success = { ...assistantError("cursor-sdk"), stopReason: "stop" as const };
		expect(rewriteCursorOverflowAssistantMessage(success, true)).toBeUndefined();
	});

	it("ignores Cursor throttling messages", () => {
		expect(
			rewriteCursorOverflowAssistantMessage(
				assistantError("cursor-sdk", "Too many requests, retry after 10s"),
				true,
			),
		).toBeUndefined();
	});
});

describe("registerCursorOverflowNormalization", () => {
	it("registers a message_end handler", () => {
		const registered: string[] = [];
		const fakeApi = { on: (event: string) => registered.push(event) } as unknown as Parameters<
			typeof registerCursorOverflowNormalization
		>[0];
		registerCursorOverflowNormalization(fakeApi);
		expect(registered).toContain("message_end");
	});
});
