import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	parseCursorReplayToolDetails,
} from "../src/cursor-replay-tool-details.js";
import { renderCursorReplayResult } from "../src/cursor-native-tool-display-replay.js";
import { createRenderTheme, paintRenderedNode } from "./helpers/render-fixtures.js";

const theme = createRenderTheme();

function renderReplayResult(details: unknown, text = "ok", isError = false): string {
	return paintRenderedNode(
		renderCursorReplayResult({ content: [{ type: "text", text }], details }, { expanded: false, isPartial: false }, theme, undefined, isError),
		120,
	);
}

describe("cursor replay tool details contract", () => {
	it("parses known nativeEdit, nativeWrite, activity, generateImage, and genericFallback detail variants", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "nativeEdit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "nativeWrite",
			path: "out.txt",
			linesCreated: 3,
		});
		const activity = parseCursorReplayToolDetails({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
		});
		const image = parseCursorReplayToolDetails({
			variant: "generateImage",
			imagePath: "/tmp/out.png",
			summary: "saved /tmp/out.png",
		});
		const fallback = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "futureTool",
			summary: "done",
		});

		expect(edit).toMatchObject({ variant: "nativeEdit" });
		expect(write).toMatchObject({ variant: "nativeWrite" });
		expect(activity).toMatchObject({ variant: "activity", sourceToolName: "mcp", title: "Cursor MCP" });
		expect(image).toMatchObject({ variant: "generateImage" });
		expect(fallback).toMatchObject({ variant: "genericFallback", sourceToolName: "futureTool" });
	});

	it("does not upgrade payloads without current replay variants", () => {
		expect(parseCursorReplayToolDetails({ path: "src/a.ts" })).toBeUndefined();
		expect(parseCursorReplayToolDetails({ variant: "activity", title: "Cursor MCP" })).toMatchObject({
			variant: "activity",
			sourceToolName: "unregisteredActivity",
			title: "Cursor MCP",
		});
		expect(parseCursorReplayToolDetails({ variant: "edit", path: "src/a.ts" })).toBeUndefined();
	});

	it("parses activity details and ignores unknown fields at the boundary", () => {
		const parsed = parseCursorReplayToolDetails({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
			untrusted: "drop-me",
		});
		expect(parsed).toMatchObject({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
		});
		expect(parsed).not.toHaveProperty("untrusted");
	});

	it("parses explicit nativeEdit and nativeWrite variants without title reclassification", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "nativeEdit",
			title: "Cursor edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "nativeWrite",
			title: "Cursor write",
			path: "out.txt",
			linesCreated: 3,
		});

		expect(edit).toMatchObject({ variant: "nativeEdit", path: "src/a.ts" });
		expect(edit).not.toHaveProperty("title");
		expect(write).toMatchObject({ variant: "nativeWrite", path: "out.txt" });
		expect(write).not.toHaveProperty("title");
	});

	it("keeps genericFallback strict instead of repairing known source names in render parsing", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "write",
			path: "out.txt",
			linesCreated: 2,
		});
		const image = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "generateImage",
			imagePath: "/tmp/out.png",
		});

		expect(edit).toMatchObject({ variant: "genericFallback", sourceToolName: "edit" });
		expect(write).toMatchObject({ variant: "genericFallback", sourceToolName: "write" });
		expect(image).toMatchObject({ variant: "genericFallback", sourceToolName: "generateImage" });
	});

	it("renders nativeEdit replay through the typed edit renderer path", () => {
		const rendered = renderReplayResult({
			variant: "nativeEdit",
			path: "src/example.ts",
			diffString: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		expect(rendered).toContain("edit");
		expect(rendered).toContain("src/example.ts");
		expect(rendered).toContain("added 1 line");
	});

	it("renders nativeWrite replay through the typed write renderer path", () => {
		const rendered = renderReplayResult({
			variant: "nativeWrite",
			path: "notes.txt",
			linesCreated: 2,
			expandedText: "hello\nworld",
		});
		expect(rendered).toContain("write");
		expect(rendered).toContain("notes.txt");
		expect(rendered).toContain("2 lines");
	});

	it("produces typed generateImage details from the display spec producer", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "success", value: { filePath: "/tmp/generated.png" }, error: undefined },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const details = parseCursorReplayToolDetails(display.result.details);
		expect(details).toMatchObject({
			variant: "generateImage",
			imagePath: "/tmp/generated.png",
		});
		expect(details).not.toHaveProperty("title");
	});

	it("renders generateImage producer details with the current visible title and path", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "success", value: { filePath: "/tmp/generated.png" }, error: undefined },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");
		expect(rendered).toContain(`${CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE} generated.png`);
		expect(rendered).not.toContain("Cursor generateImage");
	});

	it("renders path-only edit errors with the activity error body", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "edit",
			name: "edit",
			args: { path: "src/a.ts" },
			result: { status: "error", value: undefined, error: "no match" },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "", true);

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
		});
		expect(rendered).toContain("Cursor edit");
		expect(rendered).toContain("Error: no match");
		expect(rendered).not.toMatch(/^edit src\/a\.ts$/m);
	});

	it("renders path-only edit no-change results with the Cursor edit activity title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "edit",
			name: "edit",
			args: { path: "src/a.ts" },
			result: { status: "success", value: { linesAdded: 0, linesRemoved: 0 }, error: undefined },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
		});
		expect(rendered).toContain("Cursor edit");
		expect(rendered).not.toMatch(/^edit src\/a\.ts$/m);
	});

	it("renders path-only write errors with the activity error body", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "write",
			name: "write",
			args: { path: "src/a.ts" },
			result: { status: "error", value: undefined, error: "permission denied" },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "", true);

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: "write",
			title: "Cursor write",
		});
		expect(rendered).toContain("write src/a.ts");
		expect(rendered).toContain("Error: permission denied");
		expect(rendered).not.toMatch(/^write src\/a\.ts$/m);
	});

	it("renders generateImage producer error details with the current visible title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "error", value: undefined, error: "image generation failed" },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = paintRenderedNode(
			renderCursorReplayResult(
				{
					content: display.result.content,
					details: display.result.details,
				},
				{ expanded: false, isPartial: false },
				theme,
				undefined,
				true,
			),
			120,
		);
		expect(rendered).toContain(CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE);
		expect(rendered).not.toContain("Cursor generateImage");
		expect(rendered).not.toMatch(/^image generation failed$/m);
	});
});
