import { describe, it, expect } from "vitest";
import type { Context } from "@oh-my-pi/pi-ai";
import { computeCursorContextFingerprint } from "../src/context.js";
import {
	buildCursorSessionSendPrompt,
	MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
	planCursorSessionSend,
} from "../src/cursor-session-send-policy.js";
import { getCursorToolTailGuardText } from "../src/context.js";

describe("cursor-session-send-policy", () => {
	it("plans initial bootstrap without resetting the agent", () => {
		const context: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const plan = planCursorSessionSend(
			{ bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
			context,
		);

		expect(plan).toEqual({ mode: "bootstrap", resetAgent: false, reason: "initial" });
	});

	it("plans incremental sends below the rebootstrap threshold", () => {
		const priorContext: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{ role: "user", content: "Follow up", timestamp: 2 },
			],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP - 1,
		};

		expect(planCursorSessionSend(sendState, context)).toEqual({
			mode: "incremental",
			resetAgent: false,
			reason: "incremental",
			appendedFrom: 1,
		});
	});

	it("plans agent reset and bootstrap at the incremental threshold", () => {
		const priorContext: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{ role: "user", content: "Follow up", timestamp: 2 },
			],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
		};

		expect(planCursorSessionSend(sendState, context)).toEqual({
			mode: "bootstrap",
			resetAgent: true,
			reason: "incremental_threshold",
		});
	});

	it("plans context-divergence bootstrap with agent reset", () => {
		const priorContext: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const editedContext: Context = {
			messages: [{ role: "user", content: "Hello edited", timestamp: 1 }],
		};
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(priorContext),
			incrementalSendCount: 2,
		};

		expect(planCursorSessionSend(sendState, editedContext)).toEqual({
			mode: "bootstrap",
			resetAgent: true,
			reason: "context_divergence",
		});
	});

	it("builds bootstrap and incremental prompts from the send plan", () => {
		const context: Context = {
			systemPrompt: "Be helpful.",
			messages: [{ role: "user", content: "Follow up", timestamp: 3 }],
		};
		const bootstrapPrompt = buildCursorSessionSendPrompt(context, {}, {
			mode: "bootstrap",
			resetAgent: false,
			reason: "initial",
		});
		const incrementalPrompt = buildCursorSessionSendPrompt(context, {}, {
			mode: "incremental",
			resetAgent: false,
			reason: "incremental",
		});

		expect(bootstrapPrompt.text).toContain("Cursor SDK tool boundary:");
		expect(bootstrapPrompt.text.endsWith(getCursorToolTailGuardText())).toBe(true);
		expect(incrementalPrompt.text).not.toContain("Cursor SDK tool boundary:");
		expect(incrementalPrompt.text.endsWith(getCursorToolTailGuardText())).toBe(true);
	});
});
