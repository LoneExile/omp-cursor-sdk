import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { asRecord, getArray, getRecord, getString, stringifyUnknown as stringifyUnknownValue } from "./cursor-record-utils.js";

export interface TranscriptOptions {
	maxChars?: number;
	maxLines?: number;
	maxListItems?: number;
	cwd?: string;
}

export interface NormalizedResult {
	status: string | undefined;
	value: unknown;
	error: unknown;
}

interface PiToolDisplayContent {
	type: "text";
	text: string;
}

export interface PiToolDisplayResult {
	content: PiToolDisplayContent[];
	details?: unknown;
}

export interface CursorPiToolDisplay {
	toolName: string;
	args: Record<string, unknown>;
	result: PiToolDisplayResult;
	isError: boolean;
}

export const DEFAULT_MAX_TRANSCRIPT_CHARS = 24000;
export const DEFAULT_MAX_TRANSCRIPT_LINES = 800;
export const DEFAULT_MAX_LIST_ITEMS = 200;
export const DEFAULT_READ_TRANSCRIPT_CHARS = 4000;
export const DEFAULT_READ_TRANSCRIPT_LINES = 12;
export const DEFAULT_NATIVE_READ_DISPLAY_LINES = 20;
export const LOCAL_READ_PREVIEW_NOTICE =
	"[local file preview at transcript time; Cursor read result content was unavailable]";

export function getToolName(toolCall: unknown): string {
	const record = asRecord(toolCall);
	return getString(record, "name") ?? getString(record, "type") ?? getString(record, "toolName") ?? "unknown";
}

export function getToolArgs(toolCall: unknown): Record<string, unknown> {
	const record = asRecord(toolCall);
	return getRecord(record, "args") ?? getRecord(record, "input") ?? {};
}

export function getToolResult(toolCall: unknown): unknown {
	const record = asRecord(toolCall);
	return record?.result;
}

export function normalizeResult(result: unknown): NormalizedResult {
	const record = asRecord(result);
	const status = getString(record, "status");
	if (status === "success" || status === "error") {
		return { status, value: record?.value, error: record?.error };
	}
	return { status, value: result, error: undefined };
}

export function stringifyUnknown(value: unknown): string {
	return stringifyUnknownValue(value, { pretty: true });
}

export function limitText(text: string, options: TranscriptOptions = {}, knownTotalLines?: number): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
	const maxLines = options.maxLines ?? DEFAULT_MAX_TRANSCRIPT_LINES;
	const lines = text.split("\n");
	let limitedLines = lines.slice(0, maxLines);
	let limited = limitedLines.join("\n");
	let truncatedLines = Math.max((knownTotalLines ?? lines.length) - limitedLines.length, 0);
	let truncatedChars = 0;

	if (limited.length > maxChars) {
		truncatedChars += limited.length - maxChars;
		limited = limited.slice(0, maxChars);
		limitedLines = limited.split("\n");
		truncatedLines = Math.max(truncatedLines, Math.max((knownTotalLines ?? lines.length) - limitedLines.length, 0));
	}
	if (text.length > limited.length) {
		truncatedChars += Math.max(text.length - limited.length - truncatedChars, 0);
	}

	const suffixParts: string[] = [];
	if (truncatedLines > 0) suffixParts.push(`${truncatedLines} more lines`);
	if (truncatedChars > 0 && truncatedLines === 0) suffixParts.push(`${truncatedChars} more chars`);
	return suffixParts.length > 0 ? `${limited}\n... (${suffixParts.join(", ")} truncated)` : limited;
}

export function limitItems<T>(items: T[], options: TranscriptOptions = {}): { items: T[]; omitted: number } {
	const maxListItems = options.maxListItems ?? DEFAULT_MAX_LIST_ITEMS;
	return { items: items.slice(0, maxListItems), omitted: Math.max(items.length - maxListItems, 0) };
}

export function joinSections(header: string, body?: string): string {
	const trimmedBody = body?.trimEnd();
	return trimmedBody ? `${header}\n\n${trimmedBody}\n` : `${header}\n`;
}

export function formatError(error: unknown): string {
	const text = stringifyUnknown(error).trim();
	return text ? `Error: ${text}` : "Error";
}

function normalizeDisplaySeparators(path: string): string {
	return path.replace(/\\/g, "/");
}

export function formatDisplayPath(path: string, cwd = process.cwd()): string {
	const trimmed = path.trim();
	if (!trimmed) return trimmed;
	if (!isAbsolute(trimmed)) return normalizeDisplaySeparators(trimmed);
	const relativePath = relative(cwd, trimmed);
	if (!relativePath || relativePath === "") return ".";
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) return normalizeDisplaySeparators(trimmed);
	return normalizeDisplaySeparators(relativePath);
}

export function formatDiffPath(path: string, cwd = process.cwd()): string {
	if (path === "/dev/null") return path;
	return formatDisplayPath(path, cwd);
}

export function formatDiffHeaderLine(line: string, options: TranscriptOptions): string {
	const match = /^(---|\+\+\+)\s+((?:[ab]\/)?)(.+)$/.exec(line);
	if (!match) return line;
	const [, marker, prefix, rawPath] = match;
	if (!prefix && rawPath !== "/dev/null") return line;
	const displayPath = formatDiffPath(rawPath, options.cwd);
	return `${marker} ${prefix}${displayPath}`;
}

export function formatDiffString(diff: string | undefined, options: TranscriptOptions): string | undefined {
	return diff
		?.split("\n")
		.map((line) => formatDiffHeaderLine(line, options))
		.join("\n");
}

export function resolveFilePath(path: string, cwd = process.cwd()): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

export function isPathWithinCwd(filePath: string, cwd = process.cwd()): boolean {
	const relativePath = relative(cwd, filePath);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function isSensitivePreviewPath(filePath: string): boolean {
	const segments = filePath.split(/[\\/]+/).map((segment) => segment.toLowerCase());
	const basename = segments.at(-1) ?? "";
	return (
		segments.includes(".ssh") ||
		segments.includes("secrets") ||
		basename === ".env" ||
		basename.startsWith(".env.") ||
		basename === ".npmrc" ||
		basename === ".netrc" ||
		basename === "credentials" ||
		basename === "id_rsa" ||
		basename === "id_ed25519" ||
		/\.(?:pem|key|p12|pfx)$/i.test(basename)
	);
}

export function readFilePreview(path: string, options: TranscriptOptions): string | undefined {
	const cwd = options.cwd ?? process.cwd();
	const filePath = resolveFilePath(path, cwd);

	const maxChars = options.maxChars ?? DEFAULT_READ_TRANSCRIPT_CHARS;
	const maxBytes = Math.max(8192, maxChars * 4);
	let fd: number | undefined;
	try {
		const realCwd = realpathSync(cwd);
		const realFilePath = realpathSync(filePath);
		if (!isPathWithinCwd(realFilePath, realCwd) || isSensitivePreviewPath(filePath) || isSensitivePreviewPath(realFilePath)) return undefined;

		const stat = statSync(realFilePath);
		if (!stat.isFile()) return undefined;
		fd = openSync(realFilePath, "r");
		const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, bytesRead);
		if (text.includes("\0")) return undefined;
		return text;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function formatPathArg(args: Record<string, unknown>, options: TranscriptOptions, key = "path"): string | undefined {
	const path = args[key];
	return typeof path === "string" && path.trim() ? formatDisplayPath(path, options.cwd) : undefined;
}


export function firstNonEmptyLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim())?.trim();
}

export function truncateArg(value: string, maxLength = 120): string {
	return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
