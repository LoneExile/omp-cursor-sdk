import { describe, it, expect, beforeEach } from "vitest";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
// OMP's own clamp (pi-tui resolveThinkingLevelForModel -> clampThinkingLevelForModel)
// runs on --thinking / /thinking before the provider's streamSimple sees `reasoning`.
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
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

function hostClamp(config: ProviderModelConfig | undefined, level: string): string | undefined {
	const model = { ...config, provider: "cursor-sdk", api: "cursor-sdk", baseUrl: "" };
	return clampThinkingLevelForModel(model as never, level as Effort);
}

describe("OMP thinking metadata", () => {
	it("advertises grok-4.7's reasoning_effort ladder without off and keeps xhigh", () => {
		const config = register([GROK_4_7]).find((model) => model.id === "grok-4.7@256k");
		expect(config?.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high", "xhigh"], requiresEffort: true });
		expect(config).not.toHaveProperty("thinkingLevelMap");
		expect(hostClamp(config, "xhigh")).toBe("xhigh");
		expect(hostClamp(config, "max")).toBe("xhigh");
		expect(hostClamp(config, "minimal")).toBe("low");
		expect(buildCursorModelSelection("grok-4.7@256k", hostClamp(config, "xhigh") as Effort)).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "256k" },
				{ id: "reasoning_effort", value: "xhigh" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("advertises a Claude thinking+effort model as off..max", () => {
		const [config] = register([
			{
				id: "claude-opus-5",
				displayName: "Opus 5",
				parameters: [
					{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
					{
						id: "effort",
						displayName: "Effort",
						values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }],
					},
				],
				variants: [
					{
						params: [
							{ id: "thinking", value: "true" },
							{ id: "effort", value: "high" },
						],
						displayName: "Opus 5",
						isDefault: true,
					},
				],
			},
		]);
		expect(config?.reasoning).toBe(true);
		expect(config?.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			requiresEffort: false,
		});
		expect(hostClamp(config, "max")).toBe("max");
		expect(buildCursorModelSelection("claude-opus-5", "max")).toEqual({
			id: "claude-opus-5",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "effort", value: "max" },
			],
		});
		expect(buildCursorModelSelection("claude-opus-5", "off")).toEqual({
			id: "claude-opus-5",
			params: [{ id: "thinking", value: "false" }],
		});
	});

	it("advertises a reasoning model with `none` as off-capable and maps off to none", () => {
		const [config] = register([
			{
				id: "gpt-5.6-sol",
				displayName: "GPT-5.6 Sol",
				parameters: [
					{
						id: "reasoning",
						displayName: "Reasoning",
						values: [
							{ value: "none" },
							{ value: "low" },
							{ value: "medium" },
							{ value: "high" },
							{ value: "xhigh" },
							{ value: "max" },
						],
					},
				],
				variants: [{ params: [{ id: "reasoning", value: "medium" }], displayName: "GPT-5.6 Sol", isDefault: true }],
			},
		]);
		expect(config?.thinking).toEqual({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			requiresEffort: false,
		});
		expect(buildCursorModelSelection("gpt-5.6-sol", "off")).toEqual({
			id: "gpt-5.6-sol",
			params: [{ id: "reasoning", value: "none" }],
		});
		expect(buildCursorModelSelection("gpt-5.6-sol", hostClamp(config, "xhigh") as Effort)).toEqual({
			id: "gpt-5.6-sol",
			params: [{ id: "reasoning", value: "xhigh" }],
		});
	});

	it("advertises no thinking for models without a Cursor thinking control", () => {
		const [config] = register([
			{ id: "composer-2.5", displayName: "Composer 2.5", variants: [{ params: [], displayName: "Composer 2.5", isDefault: true }] },
		]);
		expect(config?.reasoning).toBe(false);
		expect(config).not.toHaveProperty("thinking");
	});
});
