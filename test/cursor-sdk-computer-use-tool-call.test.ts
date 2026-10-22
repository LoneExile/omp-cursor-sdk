import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallCompletedUpdate } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { buildIncompleteCursorToolDisplay, formatIncompleteCursorToolTrace } from "../src/cursor-incomplete-tool-visibility.js";
import { CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME } from "../src/cursor-replay-tool-details.js";
import { DISCARDED_INCOMPLETE_TOOL_CALL_REASON } from "../src/cursor-sdk-event-debug.js";
import {
	CURSOR_KNOWN_NORMALIZED_TOOL_NAMES,
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	normalizeCursorToolName,
} from "../src/cursor-tool-presentation-registry.js";
import { buildCursorPiToolDisplay, formatCursorToolTranscript } from "../src/cursor-tool-transcript.js";
import { classifyCursorToolVisibility } from "../src/cursor-tool-visibility.js";
import { resolveInstalledPackageRoot } from "./helpers/installed-package.js";

// @cursor/sdk 1.0.37 added the `computerUse` tool call (1.0.34's types have none); the plugin has no
// presentation for it, so it must go through the generic Cursor activity fallback that every tool the
// registry does not know takes. This is not a request for a computerUse presentation: when one is
// added, the registry assertion below is the line to change.

const TOOL_CALL_TYPES = join(
	resolveInstalledPackageRoot("@cursor/sdk"),
	"dist/esm/vendor/cursor-sdk-shared/tool-call-types.d.ts",
);

/** The part of `source` from the `export declare const <from>` line up to the first `<end>` after it. */
function declarationsBetween(source: string, from: string, end: string): string {
	const start = source.indexOf(`export declare const ${from}`);
	const stop = source.indexOf(end, start);
	expect(start, `${from} is declared`).toBeGreaterThanOrEqual(0);
	expect(stop, `${end} follows ${from}`).toBeGreaterThan(start);
	return source.slice(start, stop);
}

// The type the SDK delivers on a `tool-call-completed` update.
type ComputerUseToolCall = Extract<ToolCallCompletedUpdate["toolCall"], { type: "computerUse" }>;

const ARGS: ComputerUseToolCall["args"] = {
	actions: [
		{ type: "click", coordinate: { x: 10, y: 20 }, button: "left", count: 1 },
		{ type: "type", text: "hello" },
		{ type: "screenshot" },
	],
	description: "Open the settings pane",
};
const SUCCESS = {
	type: "computerUse",
	args: ARGS,
	result: { status: "success", value: { actionCount: 3, durationMs: 120, screenshotPath: "/tmp/screen.png", log: "ok" } },
} satisfies ComputerUseToolCall;
const FAILED = {
	type: "computerUse",
	args: ARGS,
	result: { status: "error", error: { message: "no display", actionCount: 1, durationMs: 5 } },
} satisfies ComputerUseToolCall;
const STARTED = { type: "computerUse", args: ARGS } satisfies ComputerUseToolCall;

describe("installed @cursor/sdk computerUse tool call (contract)", () => {
	const source = readFileSync(TOOL_CALL_TYPES, "utf8");

	it("is a `computerUse` tool call with a list of actions and an optional success or error result", () => {
		const actions = declarationsBetween(source, "ComputerUseActionSchema", "export declare const ComputerUseArgsSchema");
		const actionTypes = [...actions.matchAll(/^ {4}type: z\.ZodLiteral<"(\w+)">;$/gm)].map((match) => match[1]);
		expect(actionTypes.sort()).toEqual(
			["click", "cursorPosition", "drag", "key", "mouseDown", "mouseMove", "mouseUp", "screenshot", "scroll", "type", "wait"].sort(),
		);

		const success = declarationsBetween(source, "ComputerUseSuccessSchema", "export declare const ComputerUseErrorSchema");
		const successFields = [...success.matchAll(/^ {4}(\w+): z\.Zod/gm)].map((match) => match[1]);
		expect(successFields).toEqual(["actionCount", "durationMs", "settleMs", "screenshotPath", "cursorPosition", "log"]);

		const toolCall = declarationsBetween(source, "ComputerUseToolCallSchema", "export type ComputerUseCoordinate ");
		expect(toolCall).toContain('type: z.ZodLiteral<"computerUse">;');
		expect(toolCall).toMatch(/^ {4}args: z\.ZodObject<\{$/m);
		expect(toolCall).toMatch(/^ {4}result: z\.ZodOptional<z\.ZodDiscriminatedUnion<"status", /m);
	});
});

describe("a computerUse tool call through the generic Cursor activity fallback", () => {
	it("has no presentation of its own", () => {
		expect(CURSOR_KNOWN_NORMALIZED_TOOL_NAMES).not.toContain("computerUse");
		expect(normalizeCursorToolName("computerUse")).toBe("computerUse");
		expect(classifyCursorToolVisibility(STARTED)).toMatchObject({ normalizedName: "computerUse", lifecycleEligible: false });
	});

	it("formats a completed call as a transcript with its description, actions and result", () => {
		const transcript = formatCursorToolTranscript(SUCCESS);

		expect(transcript.startsWith("computerUse\n\n")).toBe(true);
		expect(transcript).toContain("description=Open the settings pane");
		expect(transcript).toContain('"type": "screenshot"');
		expect(transcript).toContain('"actionCount": 3');
		expect(transcript).toContain("/tmp/screen.png");
	});

	it("displays a completed call as a generic activity card", () => {
		const display = buildCursorPiToolDisplay(SUCCESS);

		expect(display.toolName).toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(display.isError).toBe(false);
		expect(display.args).toMatchObject({ activityTitle: "Cursor computerUse" });
		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
			title: "Cursor computerUse",
		});
	});

	it("displays a failed call as an error activity card carrying the error", () => {
		const display = buildCursorPiToolDisplay(FAILED);

		expect(display.toolName).toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(display.isError).toBe(true);
		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: CURSOR_REPLAY_UNREGISTERED_ACTIVITY_TOOL_NAME,
			title: "Cursor computerUse",
		});
		expect(display.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("no display") });
	});

	it("formats a call with no result yet, as a started call is", () => {
		const display = buildCursorPiToolDisplay(STARTED);

		expect(formatCursorToolTranscript(STARTED)).toContain("description=Open the settings pane");
		expect(display.toolName).toBe(CURSOR_REPLAY_ACTIVITY_TOOL_NAME);
		expect(display.args).toMatchObject({ activityTitle: "Cursor computerUse" });
	});

	it("labels a started call that never completed under the same generic title", () => {
		const display = buildIncompleteCursorToolDisplay(STARTED, DISCARDED_INCOMPLETE_TOOL_CALL_REASON);

		expect(display.args).toMatchObject({ activityTitle: "Cursor computerUse", incomplete: true });
		expect(display.isError).toBe(true);
		expect(formatIncompleteCursorToolTrace(display)).toContain("Cursor computerUse did not complete: missing completion");
	});
});
