import type { JsonValue } from "@oh-my-pi/pi-ai";

/** Narrow untyped SDK/MCP arguments at the Pi transcript boundary without rewriting them. */
export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& isJsonValue(value, new Set());
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
	ancestors.add(value);
	const valid = Object.values(value).every(entry => isJsonValue(entry, ancestors));
	ancestors.delete(value);
	return valid;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function getField(value: unknown, field: string): unknown {
	return asRecord(value)?.[field];
}

export function hasUsableText(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

export function getNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = record?.[key];
	return typeof value === "boolean" ? value : undefined;
}

export function getRecord(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	return asRecord(record?.[key]);
}

export function getArray(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
	const value = record?.[key];
	return Array.isArray(value) ? value : undefined;
}

export function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

export function stringifyUnknown(value: unknown, options: { pretty?: boolean } = {}): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, options.pretty ? 2 : undefined) ?? String(value);
	} catch {
		return String(value);
	}
}

export function getFirstStringByKeys(
	record: Record<string, unknown> | undefined,
	keys: readonly string[],
	options?: { nonEmpty?: boolean },
): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		if (options?.nonEmpty && !value) continue;
		return value;
	}
	return undefined;
}
