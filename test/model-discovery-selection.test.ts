import { describe, it, expect, beforeEach } from "vitest";
import {
	buildCursorModelSelection,
	getCursorModelMetadata,
	getCursorModelMetadataEntries,
	__testUtils,
} from "../src/model-discovery.js";
import type { ModelListItem } from "@cursor/sdk";

function register(items: ModelListItem[]) {
	return __testUtils.registerModelItems(items);
}

describe("buildCursorModelSelection", () => {
	beforeEach(() => {
		register([
			{
				id: "gpt-5.4",
				displayName: "GPT-5.4",
				parameters: [
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "272k" }] },
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [
							{ value: "none" },
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "extra-high" },
						],
					},
					{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
				],
				variants: [
					{
						params: [
							{ id: "context", value: "1m" },
							{ id: "reasoning", value: "medium" },
							{ id: "fast", value: "false" },
						],
						displayName: "GPT-5.4",
						isDefault: true,
					},
				],
			},
			{
				id: "claude-opus-4-7",
				displayName: "Opus 4.7",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{ id: "context", displayName: "Context", values: [{ value: "1m" }, { value: "300k" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
						],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "context", value: "1m" },
							{ id: "effort", value: "xhigh" },
						],
						displayName: "Opus 4.7",
						isDefault: true,
					},
				],
			},
		]);
	});

	it("uses selected context, pi thinking, and fast state", () => {
		expect(buildCursorModelSelection("gpt-5.4@272k", "xhigh", true)).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "extra-high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("turns Claude thinking off and omits effort when pi thinking is off", () => {
		expect(buildCursorModelSelection("claude-opus-4-7@300k", "off")).toEqual({
			id: "claude-opus-4-7",
			params: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "300k" },
			],
		});
	});

	it("turns Claude thinking on and maps effort when pi thinking is enabled", () => {
		expect(buildCursorModelSelection("claude-opus-4-7@1m", "high")).toEqual({
			id: "claude-opus-4-7",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "high" },
			],
		});
	});

	it("passes unknown model IDs through plainly", () => {
		expect(buildCursorModelSelection("gemini-3.1-pro", "off")).toEqual({ id: "gemini-3.1-pro" });
	});

	it("returns cloned metadata entries", () => {
		const entries = getCursorModelMetadataEntries();
		const metadata = entries.find((entry) => entry.piModelId === "gpt-5.4@1m");
		expect(metadata?.defaultParams).toEqual([
			{ id: "context", value: "1m" },
			{ id: "reasoning", value: "medium" },
			{ id: "fast", value: "false" },
		]);
		metadata!.defaultParams[0].value = "mutated";
		metadata!.thinkingLevelMap!.medium = "mutated";
		expect(getCursorModelMetadata("gpt-5.4@1m")?.defaultParams[0].value).toBe("1m");
		expect(getCursorModelMetadata("gpt-5.4@1m")?.thinkingLevelMap?.medium).toBe("medium");
	});
});

// Shape captured from live `Cursor.models.list()` for grok-4.7 (2026-09-27): its effort
// control is `reasoning_effort`, not `effort`/`reasoning`/`thinking`, and it has no off value.
const GROK_4_7: ModelListItem = {
	id: "grok-4.7",
	displayName: "Grok 4.7",
	parameters: [
		{ id: "context", displayName: "Context", values: [{ value: "256k" }, { value: "500k" }] },
		{
			id: "reasoning_effort",
			displayName: "Effort",
			values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
		},
		{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
	],
	variants: [
		{
			params: [
				{ id: "context", value: "500k" },
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "true" },
			],
			displayName: "Grok 4.7  High Fast",
			isDefault: true,
		},
	],
};

describe("reasoning_effort models", () => {
	it("advertises reasoning and maps pi thinking levels onto reasoning_effort", () => {
		const model = register([GROK_4_7]).find((config) => config.id === "grok-4.7@256k");
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBe(256000);
		expect(buildCursorModelSelection("grok-4.7@256k", "xhigh")).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "256k" },
				{ id: "reasoning_effort", value: "xhigh" },
				{ id: "fast", value: "true" },
			],
		});
		expect(buildCursorModelSelection("grok-4.7@256k@slow", "low")).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "256k" },
				{ id: "reasoning_effort", value: "low" },
				{ id: "fast", value: "false" },
			],
		});
	});

	it("keeps the catalog default effort for levels Cursor does not offer", () => {
		register([GROK_4_7]);
		const expected = {
			id: "grok-4.7",
			params: [
				{ id: "context", value: "256k" },
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "true" },
			],
		};
		expect(buildCursorModelSelection("grok-4.7@256k", "off")).toEqual(expected);
		expect(buildCursorModelSelection("grok-4.7@256k", "max")).toEqual(expected);
	});
});
