import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { formatKeyHint, getKeybindings, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { jsx, type JSXNode } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";
import { Type } from "@oh-my-pi/omptype/typebox";
import { resolveCursorEditDiff } from "./cursor-edit-diff.js";
import { cursorAnsiNode } from "./cursor-render-node.js";
import { inferImageMimeType } from "./cursor-tool-result-display-readers.js";
import {
	CURSOR_REPLAY_ACTIVITY_TOOL_NAME,
	getCursorReplayCallSummary,
	shouldShowCursorReplayCollapsedExpandHint,
	type CursorReplayToolName,
} from "./cursor-tool-presentation-registry.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	type CursorReplayNativeEditDetails,
	type CursorReplayGenerateImageDetails,
	type CursorReplayActivityDetails,
	type CursorReplayToolDetails,
	type CursorReplayNativeWriteDetails,
	isCursorReplayGenerateImageDetails,
	isCursorReplayActivityDetails,
	parseCursorReplayToolDetails,
} from "./cursor-replay-tool-details.js";

export type {
	CursorReplayNativeEditDetails,
	CursorReplayGenerateImageDetails,
	CursorReplayGenericFallbackDetails,
	CursorReplayActivityDetails,
	CursorReplayToolDetails,
	CursorReplayNativeWriteDetails,
} from "./cursor-replay-tool-details.js";
export {
	isCursorReplayNativeEditDetails,
	isCursorReplayGenerateImageDetails,
	isCursorReplayActivityDetails,
	isCursorReplayNativeWriteDetails,
	parseCursorReplayToolDetails,
} from "./cursor-replay-tool-details.js";

export const CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES = 8;
export const CURSOR_REPLAY_PREVIEW_MAX_CHARS = 4000;
export const CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS = 240;
const CURSOR_REPLAY_HIGHLIGHT_MAX_CHARS = 12000;
export const cursorReplayToolSchema = Type.Object({}, { additionalProperties: true });

type CursorReplayRenderCall = NonNullable<ToolDefinition<typeof cursorReplayToolSchema, unknown>["renderCall"]>;
type CursorReplayRenderResult = NonNullable<ToolDefinition<typeof cursorReplayToolSchema, unknown>["renderResult"]>;
export type CursorReplayRenderTheme = Parameters<CursorReplayRenderCall>[2];

const CURSOR_REPLAY_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

interface CursorReplayImage {
	readonly blob: string;
	readonly width: number;
	readonly height: number;
}

/** Loaded images by path, size and mtime: a redraw neither rereads nor rehashes an unchanged file. */
const cursorReplayImages = new Map<string, CursorReplayImage | undefined>();

/** The image file as a registered pi-tui blob with its pixel size, or undefined when it cannot be drawn. */
function loadCursorReplayImage(path: string, mimeType: string): CursorReplayImage | undefined {
	let key: string;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size <= 0 || stat.size > CURSOR_REPLAY_IMAGE_MAX_BYTES) return undefined;
		key = `${path}\0${stat.size}\0${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
	if (cursorReplayImages.has(key)) return cursorReplayImages.get(key);
	let image: CursorReplayImage | undefined;
	try {
		const bytes = readFileSync(path);
		const metadata = parseImageMetadata(bytes);
		if (metadata?.width && metadata.height) {
			image = { blob: registerBlob(bytes, mimeType), width: metadata.width, height: metadata.height };
		}
	} catch {
		image = undefined;
	}
	cursorReplayImages.set(key, image);
	return image;
}

function buildImageReplayNode(text: string, image: CursorReplayImage, filename: string): JSXNode {
	return jsx("col", {
		children: [
			cursorAnsiNode(text),
			jsx("image", {
				blob: image.blob,
				w: image.width,
				h: image.height,
				alt: `[Image: ${filename}]`,
				max: { w: "40ch", h: "16lines" },
			}),
		],
	});
}

export function getCursorReplayPath(
	args: Record<string, unknown> | undefined,
	details: Pick<CursorReplayNativeEditDetails, "path"> | Pick<CursorReplayNativeWriteDetails, "path"> | undefined,
): string {
	const argPath = args?.path;
	return details?.path ?? (typeof argPath === "string" && argPath.trim() ? argPath : "unknown");
}

function parseUnifiedDiffHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
	const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
	if (!match) return undefined;
	return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

function replaceCursorReplayTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function truncateCursorReplayLine(text: string, maxChars = CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS): string {
	return text.length > maxChars ? `${text.slice(0, Math.max(maxChars - 1, 0))}…` : text;
}

interface CursorReplayPreviewSlice {
	text: string;
	omittedLines: number;
	omittedChars: number;
}

function sliceCursorReplayPreview(
	text: string,
	maxLines: number,
	maxChars = CURSOR_REPLAY_PREVIEW_MAX_CHARS,
): CursorReplayPreviewSlice {
	const lines = text.split("\n");
	const visible: string[] = [];
	let usedChars = 0;
	let omittedChars = 0;
	for (const line of lines) {
		if (visible.length >= maxLines) {
			omittedChars += line.length + 1;
			continue;
		}
		const normalizedLine = replaceCursorReplayTabs(line);
		const lineBudget = Math.max(Math.min(CURSOR_REPLAY_PREVIEW_MAX_LINE_CHARS, maxChars - usedChars), 0);
		if (lineBudget <= 0) {
			omittedChars += normalizedLine.length + 1;
			continue;
		}
		const truncatedLine = truncateCursorReplayLine(normalizedLine, lineBudget);
		visible.push(truncatedLine);
		usedChars += truncatedLine.length + 1;
		omittedChars += Math.max(normalizedLine.length - truncatedLine.length, 0);
	}
	return {
		text: visible.join("\n"),
		omittedLines: Math.max(lines.length - visible.length, 0),
		omittedChars,
	};
}

function formatCursorReplayOmission(slice: CursorReplayPreviewSlice): string | undefined {
	const parts = [];
	if (slice.omittedLines > 0) parts.push(`${slice.omittedLines} more lines`);
	if (slice.omittedChars > 0) parts.push(`${slice.omittedChars} more chars`);
	return parts.length > 0 ? `... (${parts.join(", ")} truncated)` : undefined;
}

function formatCursorReplayDiffLine(prefix: string, lineNumber: number, content: string, theme: CursorReplayRenderTheme): string {
	const rendered = `${prefix}${lineNumber} ${truncateCursorReplayLine(replaceCursorReplayTabs(content))}`;
	if (prefix === "+") return theme.fg("toolDiffAdded", rendered);
	if (prefix === "-") return theme.fg("toolDiffRemoved", rendered);
	return theme.fg("toolDiffContext", rendered);
}

export function formatCursorReplayDiff(diff: string, theme: CursorReplayRenderTheme, maxLines: number): string {
	const lines = diff.split("\n");
	const oldFileIsNull = lines.some((line) => line === "--- /dev/null");
	const newFileIsNull = lines.some((line) => line === "+++ /dev/null");
	const rendered: string[] = [];
	let oldLine = 1;
	let newLine = 1;

	for (const line of lines) {
		if (!line || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		const hunk = parseUnifiedDiffHunkHeader(line);
		if (hunk) {
			oldLine = hunk.oldLine;
			newLine = hunk.newLine;
			continue;
		}

		if (line.startsWith("+")) {
			if (newFileIsNull) continue;
			rendered.push(formatCursorReplayDiffLine("+", newLine, line.slice(1), theme));
			newLine += 1;
		} else if (line.startsWith("-")) {
			if (oldFileIsNull && line === "-") continue;
			rendered.push(formatCursorReplayDiffLine("-", oldLine, line.slice(1), theme));
			oldLine += 1;
		} else if (line.startsWith(" ")) {
			rendered.push(formatCursorReplayDiffLine(" ", newLine, line.slice(1), theme));
			oldLine += 1;
			newLine += 1;
		} else {
			rendered.push(theme.fg("toolDiffContext", replaceCursorReplayTabs(line)));
		}
	}

	const visible = rendered.slice(0, maxLines);
	if (rendered.length > maxLines) visible.push(theme.fg("muted", `... (${rendered.length - maxLines} more diff lines hidden)`));
	return visible.join("\n");
}

function stripCursorReplayHeader(text: string): string {
	const lines = text.trimEnd().split("\n");
	return lines.length > 2 && lines[1]?.trim() === "" ? lines.slice(2).join("\n") : lines.join("\n");
}

function formatMutedBlock(text: string, theme: CursorReplayRenderTheme): string {
	return text.split("\n").map((line) => theme.fg("muted", line)).join("\n");
}

function hasUnifiedDiffHunk(text: string): boolean {
	return text.split("\n").some((line) => Boolean(parseUnifiedDiffHunkHeader(line)));
}

/** First unified-diff marker (`---`/`+++`/`@@`) so collapsed previews budget diff lines, not transcript preamble. */
function extractUnifiedDiffSection(text: string): string | undefined {
	const lines = text.split("\n");
	const markerIndex = lines.findIndex((line) => line.startsWith("--- ") || line.startsWith("+++ "));
	const hunkIndex = lines.findIndex((line) => Boolean(parseUnifiedDiffHunkHeader(line)));
	const start = markerIndex >= 0 ? markerIndex : hunkIndex;
	if (start < 0) return undefined;
	return lines.slice(start).join("\n");
}

function formatCursorReplayActivityDiffPreview(
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines: number,
	stripHeader: boolean,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	const diffSection = body ? extractUnifiedDiffSection(body) : undefined;
	if (!diffSection || !hasUnifiedDiffHunk(diffSection)) return undefined;
	// Fallback for unstructured activity details that carry a unified diff only in expanded text.
	// All actual diff coloring lives in the single `formatCursorReplayDiff` renderer.
	return formatCursorReplayDiff(diffSection, theme, maxLines);
}

function formatCursorReplayActivityEditPreview(
	details: CursorReplayExpandableResultDetails,
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines: number,
	stripHeader: boolean,
): string | undefined {
	const structuredDiff = details.diffString ?? details.diff;
	if (structuredDiff) {
		return formatCursorReplayDiff(structuredDiff, theme, maxLines);
	}
	const diffPreview = formatCursorReplayActivityDiffPreview(text, theme, maxLines, stripHeader);
	if (diffPreview) return diffPreview;
	return stripHeader ? formatCursorReplayPreview(text, theme, maxLines, true) : formatMutedBlock(text, theme);
}

function formatCursorReplayActivityWritePreview(
	details: CursorReplayExpandableResultDetails,
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines: number,
	stripHeader: boolean,
): string | undefined {
	const structuredDiff = details.diffString ?? details.diff;
	if (structuredDiff) {
		return formatCursorReplayDiff(structuredDiff, theme, maxLines);
	}
	if (details.fileContentAfterWrite) {
		return formatCursorReplayFilePreview(
			details.fileContentAfterWrite,
			details.path,
			theme,
			maxLines,
			false,
		);
	}
	const diffPreview = formatCursorReplayActivityDiffPreview(text, theme, maxLines, stripHeader);
	if (diffPreview) return diffPreview;
	return stripHeader ? formatCursorReplayPreview(text, theme, maxLines, true) : formatMutedBlock(text, theme);
}

function formatCursorReplayActivityPreview(
	details: CursorReplayExpandableResultDetails,
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines: number,
	stripHeader: boolean,
): string | undefined {
	if (details.sourceToolName === "edit") {
		return formatCursorReplayActivityEditPreview(details, text, theme, maxLines, stripHeader);
	}
	if (details.sourceToolName === "write") {
		return formatCursorReplayActivityWritePreview(details, text, theme, maxLines, stripHeader);
	}
	return stripHeader ? formatCursorReplayPreview(text, theme, maxLines, true) : formatMutedBlock(text, theme);
}

export function formatCursorReplayPreview(
	text: string,
	theme: CursorReplayRenderTheme,
	maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	stripHeader = true,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	if (!body) return undefined;
	const slice = sliceCursorReplayPreview(body, maxLines);
	const omission = formatCursorReplayOmission(slice);
	const preview = omission ? `${slice.text}\n${omission}` : slice.text;
	return formatMutedBlock(preview, theme);
}

function safeHighlightCursorReplayCode(text: string, path: string | undefined, theme: CursorReplayRenderTheme): string[] | undefined {
	const lang = path ? languageFromPath(path) : undefined;
	if (!lang || !supportsLanguage(lang)) return undefined;
	try {
		return highlightCode(replaceCursorReplayTabs(text), lang, theme);
	} catch {
		return undefined;
	}
}

export function formatCursorReplayFilePreview(
	text: string,
	path: string | undefined,
	theme: CursorReplayRenderTheme,
	maxLines = CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
	stripHeader = true,
): string | undefined {
	const body = (stripHeader ? stripCursorReplayHeader(text) : text).trimEnd();
	if (!body) return undefined;
	const slice = sliceCursorReplayPreview(body, maxLines);
	const highlightedLines = slice.text.length <= CURSOR_REPLAY_HIGHLIGHT_MAX_CHARS ? safeHighlightCursorReplayCode(slice.text, path, theme) : undefined;
	const renderedLines = highlightedLines ?? slice.text.split("\n").map((line) => theme.fg("toolOutput", line));
	const omission = formatCursorReplayOmission(slice);
	if (omission) renderedLines.push(theme.fg("muted", omission));
	return renderedLines.join("\n");
}

function getCursorReplayCardTitle(toolName: CursorReplayToolName, args: Record<string, unknown> | undefined): string {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME && typeof args?.activityTitle === "string" && args.activityTitle.trim()) {
		return args.activityTitle.trim();
	}
	return "Cursor activity";
}

export function renderCursorReplayCall(
	toolName: CursorReplayToolName,
	args: Record<string, unknown> | undefined,
	theme: CursorReplayRenderTheme,
	isPartial: boolean,
): JSXNode {
	if (!isPartial) return undefined;
	let text = theme.fg("toolTitle", theme.bold(`${getCursorReplayCardTitle(toolName, args)} `));
	const summary = getCursorReplayCallSummary(toolName, args);
	if (summary) text += theme.fg("accent", summary);
	return cursorAnsiNode(text.trimEnd());
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function getCursorEditDiff(details: CursorReplayNativeEditDetails): string | undefined {
	return resolveCursorEditDiff(details);
}

function hasCursorEditChanges(details: CursorReplayNativeEditDetails): boolean {
	return Boolean(getCursorEditDiff(details)) || Boolean(details.linesAdded) || Boolean(details.linesRemoved);
}

function classifyCursorEditOperation(details: CursorReplayNativeEditDetails): "created" | "deleted" | "updated" | "unchanged" {
	if (!hasCursorEditChanges(details)) return "unchanged";
	const diff = getCursorEditDiff(details);
	if (diff?.startsWith("--- /dev/null")) return "created";
	if (diff?.includes("\n+++ /dev/null")) return "deleted";
	return "updated";
}

function formatCursorEditSummary(details: CursorReplayNativeEditDetails): string {
	const operation = classifyCursorEditOperation(details);
	if (operation === "unchanged") return "no changes needed";
	if (operation === "created" && details.linesAdded !== undefined) return `created ${pluralize(details.linesAdded, "line")}`;
	if (operation === "deleted" && details.linesRemoved !== undefined) return `deleted ${pluralize(details.linesRemoved, "line")}`;
	const parts = [
		details.linesAdded ? `added ${pluralize(details.linesAdded, "line")}` : undefined,
		details.linesRemoved ? `removed ${pluralize(details.linesRemoved, "line")}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(", ") : "updated file";
}

function firstContentText(result: Parameters<CursorReplayRenderResult>[0]): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

type CursorReplayExpandableResultDetails = {
	summary?: string;
	expandedText?: string;
	collapseDetailsByDefault?: boolean;
	imagePath?: string;
	imageMimeType?: string;
	sourceToolName?: CursorReplayActivityDetails["sourceToolName"];
	path?: string;
	/** Structured diff fields populated on activity edit/write details for canonical coloring (primary over text parse). */
	diffString?: string;
	diff?: string;
	linesAdded?: number;
	linesRemoved?: number;
	/** Structured post-write content for activity write fallbacks; drives canonical file preview (mirrors nativeWrite). */
	fileContentAfterWrite?: string;
};

function hasCursorReplayDisplayTitle(details: CursorReplayToolDetails | undefined): boolean {
	if (!details) return false;
	return isCursorReplayActivityDetails(details) || isCursorReplayGenerateImageDetails(details);
}

function formatCursorReplayExpandHint(theme: CursorReplayRenderTheme): string {
	try {
		const key = getKeybindings().keysFor("app.tools.expand")[0] ?? "ctrl+o";
		return `${theme.fg("dim", formatKeyHint(key))}${theme.fg("muted", " to expand")}`;
	} catch {
		return "Ctrl+O to expand";
	}
}

function renderExpandableCursorReplayResult(
	title: string,
	details: CursorReplayExpandableResultDetails,
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	args: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
): JSXNode {
	const text = firstContentText(result);
	const summary = details.summary ?? text.split("\n").find((line) => line.trim()) ?? "completed";
	const expandedText = details.expandedText ?? (text.includes("\n") ? text : undefined);
	const showExpandHint = expandedText && !options.expanded && shouldShowCursorReplayCollapsedExpandHint(details.sourceToolName);
	const expandHint = showExpandHint ? theme.fg("dim", ` (${formatCursorReplayExpandHint(theme)})`) : "";
	let rendered = `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(isError ? "error" : "success", summary)}${expandHint}`;
	if (expandedText && (options.expanded || !details.collapseDetailsByDefault)) {
		const preview = formatCursorReplayActivityPreview(
			details,
			expandedText,
			theme,
			options.expanded ? Number.POSITIVE_INFINITY : CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
			!options.expanded,
		);
		if (preview) rendered += `\n${preview}`;
	}
	if (details.imagePath && !isError) {
		const mimeType = details.imageMimeType ?? inferImageMimeType(details.imagePath);
		const image = mimeType ? loadCursorReplayImage(details.imagePath, mimeType) : undefined;
		if (image) return buildImageReplayNode(rendered, image, basename(details.imagePath));
	}
	return cursorAnsiNode(rendered);
}

function renderCursorReplayEditResult(
	details: CursorReplayNativeEditDetails,
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
): JSXNode {
	const summary = formatCursorEditSummary(details);
	let rendered = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", getCursorReplayPath(undefined, details))} ${theme.fg("success", summary)}`;
	const diff = getCursorEditDiff(details);
	if (diff) rendered += `\n${formatCursorReplayDiff(diff, theme, options.expanded ? 40 : CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES)}`;
	return cursorAnsiNode(rendered);
}

function renderCursorReplayWriteResult(
	details: CursorReplayNativeWriteDetails,
	result: Parameters<CursorReplayRenderResult>[0],
	theme: Parameters<CursorReplayRenderResult>[2],
): JSXNode {
	const text = firstContentText(result);
	const parts = [
		details.linesCreated !== undefined ? `${details.linesCreated} line${details.linesCreated === 1 ? "" : "s"}` : undefined,
		details.fileSize !== undefined ? `${details.fileSize} bytes` : undefined,
	].filter(Boolean);
	const summary = parts.length > 0 ? parts.join(", ") : "written";
	let rendered = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", getCursorReplayPath(undefined, details))} ${theme.fg("success", summary)}`;
	const previewSource = details.fileContentAfterWrite ?? details.expandedText ?? text;
	const preview = formatCursorReplayFilePreview(
		previewSource,
		getCursorReplayPath(undefined, details),
		theme,
		CURSOR_REPLAY_COLLAPSED_PREVIEW_LINES,
		details.fileContentAfterWrite === undefined,
	);
	if (preview) rendered += `\n${preview}`;
	return cursorAnsiNode(rendered);
}

function renderCursorGenerateImageResult(
	details: CursorReplayGenerateImageDetails,
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	args: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
): JSXNode {
	const title = CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE;
	return renderExpandableCursorReplayResult(title, details, result, options, theme, args, isError);
}

function renderCursorReplayDetails(
	details: CursorReplayToolDetails,
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	args: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
	text: string,
): JSXNode {
	switch (details.variant) {
		case "nativeEdit":
			return renderCursorReplayEditResult(details, options, theme);
		case "nativeWrite":
			return renderCursorReplayWriteResult(details, result, theme);
		case "generateImage":
			return renderCursorGenerateImageResult(details, result, options, theme, args, isError);
		case "activity":
			return renderExpandableCursorReplayResult(details.title, details, result, options, theme, args, isError);
		case "genericFallback":
			break;
		default: {
			const _exhaustive: never = details;
			return _exhaustive;
		}
	}
	return cursorAnsiNode(text || theme.fg("success", "Cursor tool result replayed"));
}

export function renderCursorReplayResult(
	result: Parameters<CursorReplayRenderResult>[0],
	options: Parameters<CursorReplayRenderResult>[1],
	theme: Parameters<CursorReplayRenderResult>[2],
	args: Parameters<CursorReplayRenderResult>[3],
	isError: boolean,
): JSXNode {
	if (options.isPartial) return cursorAnsiNode(theme.fg("warning", "Replaying Cursor tool result..."));
	const details = parseCursorReplayToolDetails(result.details);
	const text = firstContentText(result);
	if (isError && !hasCursorReplayDisplayTitle(details)) {
		return cursorAnsiNode(theme.fg("error", text.split("\n")[0] || "Cursor replay failed"));
	}
	if (!details) return cursorAnsiNode(text || theme.fg("success", "Cursor tool result replayed"));
	return renderCursorReplayDetails(details, result, options, theme, args, isError, text);
}

export function createCursorReplayOnlyToolDefinition(toolName: CursorReplayToolName): ToolDefinition<typeof cursorReplayToolSchema, unknown> {
	return {
		name: toolName,
		label: "Cursor activity",
		description: "Display recorded Cursor SDK tool activity. This tool only returns recorded Cursor results and never executes work directly.",
		parameters: cursorReplayToolSchema,
		async execute() {
			throw new Error("No recorded Cursor activity result was available. This replay-only tool does not execute work directly.");
		},
		renderCall(args, options, theme) {
			return renderCursorReplayCall(toolName, args as Record<string, unknown>, theme, options.isPartial);
		},
		renderResult(result, options, theme, args) {
			return renderCursorReplayResult(result, options, theme, args, result.isError === true);
		},
	};
}
