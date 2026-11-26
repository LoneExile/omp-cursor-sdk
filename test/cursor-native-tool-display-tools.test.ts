import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import * as replay from "../src/cursor-native-tool-display-replay.js";
import { wrapNativeCursorTool } from "../src/cursor-native-tool-display-tools.js";
import { createRenderContext, createRenderOptions, createRenderTheme } from "./helpers/render-fixtures.js";

describe("wrapNativeCursorTool", () => {
	it("does not use Cursor replay rendering for ordinary pi edit toolCallIds", () => {
		const replaySpy = vi.spyOn(replay, "renderCursorReplayResult").mockReturnValue(undefined);
		const parameters = Type.Object({});
		type EditToolDefinition = ToolDefinition<typeof parameters, unknown, unknown>;
		const delegateRenderResult = vi.fn<NonNullable<EditToolDefinition["renderResult"]>>(() => "pi edit");
		const definition: EditToolDefinition = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters,
			execute: vi.fn(async () => ({ content: [], details: undefined })),
			renderResult: delegateRenderResult,
		};
		const wrapped = wrapNativeCursorTool(definition, () => definition);
		const theme = createRenderTheme();

		wrapped.renderResult?.(
			{
				content: [{ type: "text", text: "edit src/foo.ts" }],
				details: {
					path: "src/foo.ts",
					diffString: "--- a\n+++ b\n",
					linesAdded: 1,
					linesRemoved: 1,
				},
			},
			createRenderOptions(),
			theme,
			createRenderContext({ isError: false, toolCallId: "ordinary-edit-1" }),
		);

		expect(replaySpy).not.toHaveBeenCalled();
		expect(delegateRenderResult).toHaveBeenCalledOnce();
		replaySpy.mockRestore();
	});
});
