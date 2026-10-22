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
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

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

// Catalog shape captured from live `Cursor.models.list()` (see src/cursor-fallback-models.generated.ts):
// Claude Opus exposes `thinking` + `effort`, Claude Haiku 5.5 exposes `thinking` + `reasoning_effort`.
// Both must behave the same: enabled levels send thinking=true + the mapped effort, `off` sends
// thinking=false and no effort parameter at all.
const ENABLED_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

function claudeLikeModel(effortId: "effort" | "reasoning_effort", defaultThinking: "true" | "false"): ModelListItem {
	return {
		id: "claude-like",
		displayName: "Claude Like",
		parameters: [
			{ id: "thinking", displayName: "Thinking", values: [{ value: "false" }, { value: "true" }] },
			{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
			{ id: effortId, displayName: "Effort", values: ENABLED_LEVELS.map((value) => ({ value })) },
		],
		variants: [
			{
				params: [
					{ id: "thinking", value: defaultThinking },
					{ id: "context", value: "1m" },
					{ id: effortId, value: "medium" },
				],
				displayName: "Claude Like",
				isDefault: true,
			},
		],
	};
}

describe.each(["effort", "reasoning_effort"] as const)("boolean thinking plus %s", (effortId) => {
	it("advertises native off..max and maps off to thinking=false", () => {
		const [config] = register([claudeLikeModel(effortId, "true")]);
		expect(config?.reasoning).toBe(true);
		expect(config?.thinking).toEqual({ mode: "effort", efforts: [...ENABLED_LEVELS], requiresEffort: false });
		expect(getCursorModelMetadata("claude-like@1m")?.thinkingLevelMap).toEqual({
			off: "false",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it.each(ENABLED_LEVELS)("sends thinking=true and %s as the effort", (level) => {
		register([claudeLikeModel(effortId, "true")]);
		expect(buildCursorModelSelection("claude-like@300k", level)).toEqual({
			id: "claude-like",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "300k" },
				{ id: effortId, value: level },
			],
		});
	});

	it.each(ENABLED_LEVELS)("re-enables thinking for %s when the catalog default has thinking=false", (level) => {
		register([claudeLikeModel(effortId, "false")]);
		expect(buildCursorModelSelection("claude-like@1m", level)).toEqual({
			id: "claude-like",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "1m" },
				{ id: effortId, value: level },
			],
		});
	});

	it("sends thinking=false and no effort parameter when pi thinking is off", () => {
		register([claudeLikeModel(effortId, "true")]);
		expect(buildCursorModelSelection("claude-like@300k", "off")).toEqual({
			id: "claude-like",
			params: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "300k" },
			],
		});
	});

	it("leaves the catalog default untouched for a level the model does not offer", () => {
		register([claudeLikeModel(effortId, "true")]);
		expect(buildCursorModelSelection("claude-like@1m", "minimal")).toEqual({
			id: "claude-like",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "1m" },
				{ id: effortId, value: "medium" },
			],
		});
	});
});

describe("fallback catalog Claude Haiku 5.5", () => {
	const haiku = FALLBACK_MODEL_ITEMS.find((item) => item.id === "claude-haiku-5-5");

	it("is present in the fallback snapshot with boolean thinking and reasoning_effort", () => {
		expect(haiku?.parameters?.map((parameter) => parameter.id)).toEqual(["thinking", "context", "reasoning_effort"]);
	});

	it.each(["300k", "1m"])("selects thinking and reasoning_effort natively at @%s", (context) => {
		if (!haiku) throw new Error("claude-haiku-5-5 is missing from the fallback snapshot");
		const config = register([haiku]).find((candidate) => candidate.id === `claude-haiku-5-5@${context}`);
		expect(config?.thinking).toEqual({ mode: "effort", efforts: [...ENABLED_LEVELS], requiresEffort: false });
		expect(buildCursorModelSelection(`claude-haiku-5-5@${context}`, "xhigh")).toEqual({
			id: "claude-haiku-5-5",
			params: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: context },
				{ id: "reasoning_effort", value: "xhigh" },
			],
		});
		expect(buildCursorModelSelection(`claude-haiku-5-5@${context}`, "off")).toEqual({
			id: "claude-haiku-5-5",
			params: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: context },
			],
		});
	});
});

describe("context windows of fast/slow lanes", () => {
	// Bundled measurement (src/bundled-context-windows.ts): claude-opus-4-8@1m = 300000. The fast
	// lane does not change the window (live: grok-4.6 and grok-4.6@fast both measure 256000).
	const OPUS_4_8: ModelListItem = {
		id: "claude-opus-4-8",
		displayName: "Opus 4.8",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "300k" }, { value: "1m" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "fast", value: "false" },
				],
				displayName: "Opus 4.8",
				isDefault: true,
			},
		],
	};

	it("uses the measured window of the same model and context for non-default lanes", () => {
		const windows = Object.fromEntries(register([OPUS_4_8]).map((model) => [model.id, model.contextWindow]));
		expect(windows["claude-opus-4-8@1m"]).toBe(300000);
		expect(windows["claude-opus-4-8@1m@slow"]).toBe(300000);
		expect(windows["claude-opus-4-8@1m@fast"]).toBe(300000);
	});
});
