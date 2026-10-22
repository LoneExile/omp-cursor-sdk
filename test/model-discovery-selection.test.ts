import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
// OMP's own clamp (pi-tui resolveThinkingLevelForModel -> clampThinkingLevelForModel)
// runs on --thinking / /thinking before the provider's streamSimple sees `reasoning`.
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatBundledContextWindowsHeader } from "../shared/cursor-bundled-context-windows-header.mjs";
import { BUNDLED_CONTEXT_WINDOWS } from "../src/bundled-context-windows.js";
import {
	buildCursorModelSelection,
	getCursorModelMetadata,
	getCursorModelMetadataEntries,
	isCursorSelectionMaxModeOnly,
	__testUtils,
} from "../src/model-discovery.js";
import type { ModelListItem, ModelSelection } from "@cursor/sdk";
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
	// A lane without its own measurement uses the window of the same model and context: grok-4.6 and
	// grok-4.6@fast both measure 256000 live (src/bundled-context-windows.ts has one row for the default lane).
	const GROK_4_6: ModelListItem = {
		id: "grok-4.6",
		displayName: "Grok 4.6",
		parameters: [{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] }],
		variants: [{ params: [{ id: "fast", value: "false" }], displayName: "Grok 4.6", isDefault: true }],
	};
	// gpt-5.4@1m measures 922000, not the 1000000 its label would give. Its `@fast` lane has an explicit
	// 272000 row: the catalog lists no 1m fast=true variant, so @cursor/sdk does not run it in Max Mode.
	const GPT_5_4: ModelListItem = {
		id: "gpt-5.4",
		displayName: "GPT-5.4",
		parameters: [
			{ id: "context", displayName: "Context", values: [{ value: "272k" }, { value: "1m" }] },
			{ id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
		],
		variants: [
			{
				params: [
					{ id: "context", value: "1m" },
					{ id: "fast", value: "false" },
				],
				displayName: "GPT-5.4",
				isDefault: true,
			},
		],
	};

	it("uses the measured window of the same model and context for a lane without its own row", () => {
		const windows = Object.fromEntries(register([GROK_4_6]).map((model) => [model.id, model.contextWindow]));
		expect(windows["grok-4.6"]).toBe(256000);
		expect(windows["grok-4.6@slow"]).toBe(256000);
		expect(windows["grok-4.6@fast"]).toBe(256000);
	});

	it("lets an explicit lane row override the context's window", () => {
		const windows = Object.fromEntries(register([GPT_5_4]).map((model) => [model.id, model.contextWindow]));
		expect(windows["gpt-5.4@1m"]).toBe(922000);
		expect(windows["gpt-5.4@1m@slow"]).toBe(922000);
		expect(windows["gpt-5.4@1m@fast"]).toBe(272000);
	});
});

describe("bundled context windows under @cursor/sdk 1.0.40 Max Mode", () => {
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	interface WindowCapture {
		id: string;
		maxModeToggle: boolean;
		resolvedMaxMode: boolean;
		maxTokens: number;
		selection: ModelSelection;
	}
	const fixture: { captures: WindowCapture[] } = JSON.parse(
		readFileSync(join(repoRoot, "test/fixtures/cursor-sdk-1.0.40-context-window-captures.json"), "utf8"),
	);
	const captures = fixture.captures;

	it("starts with the header the snapshot generator writes, so a refresh cannot revert it", () => {
		const source = readFileSync(join(repoRoot, "src/bundled-context-windows.ts"), "utf8");
		const date = /^\/\/ Generated from Cursor SDK checkpoint tokenDetails\.maxTokens on (\d{4}-\d{2}-\d{2})\./.exec(source)?.[1];
		expect(date).toBeDefined();
		expect(source.startsWith(`${formatBundledContextWindowsHeader(date ?? "")}export const BUNDLED_CONTEXT_WINDOWS = {`)).toBe(true);
	});

	it("backs every `@1m` row with a live checkpoint capture, taking the toggle-off window where one was measured", () => {
		const rows = Object.keys(BUNDLED_CONTEXT_WINDOWS).filter((id) => /@1m(?:@fast)?$/.test(id));
		expect(rows.length).toBeGreaterThan(0);
		for (const id of rows) {
			const own = captures.filter((capture) => capture.id === id);
			expect(own.length, `${id} has no capture`).toBeGreaterThan(0);
			// With Max Mode off a variant the catalog does not list runs outside Max Mode: that window is the floor.
			const floor = own.find((capture) => !capture.maxModeToggle) ?? own[0];
			expect(BUNDLED_CONTEXT_WINDOWS[id as keyof typeof BUNDLED_CONTEXT_WINDOWS], id).toBe(floor?.maxTokens);
		}
	});

	it("matches each capture's Max Mode outcome to the catalog's Max Mode only rule", () => {
		register(FALLBACK_MODEL_ITEMS);
		for (const capture of captures) {
			const { maxMode: sentMaxMode, ...selection } = capture.selection;
			// The toggle decides what the plugin sends: maxMode: true with it on, nothing with it off.
			expect(sentMaxMode === true, `${capture.id} toggle=${capture.maxModeToggle}: what was sent`).toBe(capture.maxModeToggle);
			const maxOnly = isCursorSelectionMaxModeOnly(capture.id, selection);
			// Toggle on always runs in Max Mode; with the toggle off, only the Max Mode only variants still do.
			expect(capture.resolvedMaxMode, `${capture.id} toggle=${capture.maxModeToggle}: what the SDK ran`).toBe(capture.maxModeToggle || maxOnly);
		}
	});

	it("shows @cursor/sdk forcing Max Mode on a default-lane `@1m` variant with the toggle off, at the advertised window", () => {
		const forcedWithToggleOff = captures.filter((capture) => !capture.maxModeToggle && capture.resolvedMaxMode && /@1m$/.test(capture.id));
		expect(forcedWithToggleOff.map((capture) => capture.id)).toEqual(
			expect.arrayContaining(["claude-sonnet-4-6@1m", "gpt-5.4@1m"]),
		);
		for (const capture of forcedWithToggleOff) {
			// The plugin sent no maxMode, yet the SDK ran Max Mode and the window is the full `@1m` one.
			expect(capture.selection, capture.id).not.toHaveProperty("maxMode");
			expect(capture.maxTokens, capture.id).toBeGreaterThan(300_000);
			expect(BUNDLED_CONTEXT_WINDOWS[capture.id as keyof typeof BUNDLED_CONTEXT_WINDOWS], capture.id).toBe(capture.maxTokens);
		}
	});

	it("advertises more than 300k only for variants the catalog lists as Max Mode only, in every thinking level", () => {
		const catalog: ModelListItem[] = FALLBACK_MODEL_ITEMS;
		const configs = register(catalog);
		const catalogHasMaxModeVariants = catalog.some((item) => item.variants?.some((variant) => variant.isMaxMode === true));
		expect(catalogHasMaxModeVariants, "the fallback catalog must carry ModelVariant.isMaxMode").toBe(true);
		const advertisedAbove300k = configs.filter((config) => config.contextWindow > 300_000);
		expect(advertisedAbove300k.length).toBeGreaterThan(0);
		for (const config of advertisedAbove300k) {
			const metadata = getCursorModelMetadata(config.id);
			expect(metadata, config.id).toBeDefined();
			for (const level of levels) {
				if (level !== "off" && metadata?.thinkingLevelMap?.[level] == null) continue;
				// Without Max Mode the SDK would not force it for a variant outside this rule, and the
				// window above 300k does not exist: such a variant needs an explicit conservative row.
				const selection = buildCursorModelSelection(config.id, level);
				expect(isCursorSelectionMaxModeOnly(config.id, selection), `${config.id} at ${level}: ${JSON.stringify(selection.params)}`).toBe(true);
			}
		}
	});
});
