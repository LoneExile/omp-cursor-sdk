import type {
	ModelListItem,
	ModelParameterDefinition,
	ModelParameterValue,
	ModelSelection,
	ModelVariant,
} from "@cursor/sdk";
import type { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { encodePiModelId, getCursorModelSelectionIdentities } from "../shared/cursor-model-selection-identities.mjs";
import { loadContextWindowCache } from "./context-window-cache.js";
import { loadCursorSdk } from "./cursor-sdk-runtime.js";
import { CURSOR_API_KEY_SETUP_HINT, resolveCursorApiKey, resolveCursorRuntimeApiKey } from "./cursor-api-key.js";
import { scrubSensitiveText } from "./cursor-sensitive-text.js";
import {
	fingerprintApiKey,
	loadAnyCachedModelCatalog,
	loadFreshCachedModels,
	saveModelListCache,
} from "./model-list-cache.js";

// Vendored from Pi 0.84's pi-ai: the plugin's internal level → Cursor value map.
// OMP's SimpleStreamOptions `reasoning` is `Effort` (minimal..max); "off" is the
// extension's own level for "OMP sent no effort".
type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

// OMP's canonical effort order (pi-catalog THINKING_EFFORTS). pi-catalog's `Effort`
// is a const enum whose members are these literal strings.
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 16384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TEXT_AND_IMAGE_INPUT: ProviderModelConfig["input"] = ["text", "image"];
// Startup discovery reads only CURSOR_API_KEY (resolveCursorRuntimeApiKey), never omp's --api-key flag.
const AUTH_SETUP_HINT = `Cursor Agent CLI/Desktop login is not reused. ${CURSOR_API_KEY_SETUP_HINT}`;

export type CursorModelFallbackReason = "missing-api-key" | "discovery-failed" | "empty-model-list" | "cached-after-error";

export interface CursorModelFallbackIssue {
	reason: CursorModelFallbackReason;
	message: string;
	errorMessage?: string;
}

export interface DiscoverModelsOptions {
	onFallback?: (issue: CursorModelFallbackIssue) => void;
	apiKey?: string;
	// Bypass the on-disk model cache and always hit the live catalog. Used by the
	// /cursor-refresh-models command; the startup path leaves this false so warm
	// boots skip the slow network round-trip.
	forceRefresh?: boolean;
}

async function getDiscoveryApiKey(apiKey?: string): Promise<string | undefined> {
	return resolveCursorApiKey(apiKey) ?? resolveCursorRuntimeApiKey();
}

export interface CursorModelMetadata {
	piModelId: string;
	baseModelId: string;
	selectionModelId: string;
	displayName: string;
	defaultParams: ModelParameterValue[];
	context?: string;
	contextWindow: number;
	supportsFast: boolean;
	defaultFast: boolean;
	fastOverride?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	parameterIds: {
		context: boolean;
		reasoning: boolean;
		effort: boolean;
		reasoningEffort: boolean;
		thinking: boolean;
		fast: boolean;
	};
}

const metadataByPiModelId = new Map<string, CursorModelMetadata>();
// The catalog's variants per base model id, kept whole so a selection can be checked against
// `ModelVariant.isMaxMode` the way @cursor/sdk does when it resolves a model.
const catalogVariantsByBaseModelId = new Map<string, readonly ModelVariant[]>();

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
	return params.map((param) => ({ ...param }));
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
	return item.parameters?.find((parameter) => parameter.id === id);
}

function hasBooleanValues(parameter: ModelParameterDefinition | undefined): boolean {
	const values = new Set((parameter?.values ?? []).map((value) => value.value.toLowerCase()));
	return values.has("false") && values.has("true");
}

function getParameterValue(parameter: ModelParameterDefinition | undefined, lowerValue: string): string | null {
	const value = parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue);
	return value?.value ?? null;
}

function getPreferredParameterValue(
	parameter: ModelParameterDefinition | undefined,
	lowerValues: string[],
): string | null {
	for (const value of lowerValues) {
		const candidate = getParameterValue(parameter, value);
		if (candidate) return candidate;
	}
	return null;
}

function mapComparableLevel(
	parameter: ModelParameterDefinition | undefined,
	level: Exclude<ModelThinkingLevel, "off">,
): string | null {
	if (level === "xhigh") {
		return getPreferredParameterValue(parameter, ["xhigh", "extra-high"]);
	}
	return getParameterValue(parameter, level);
}

function getThinkingLevelMap(item: ModelListItem): ThinkingLevelMap | undefined {
	const reasoningParameter = getParameter(item, "reasoning");
	const effortParameter = getParameter(item, "effort");
	// grok-4.7 and gemini-3.8-flash expose their effort control as `reasoning_effort`.
	const reasoningEffortParameter = getParameter(item, "reasoning_effort");
	const thinkingParameter = getParameter(item, "thinking");
	const valueParameter = effortParameter ?? reasoningEffortParameter ?? reasoningParameter ?? thinkingParameter;
	if (!valueParameter) return undefined;

	if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
		return {
			off: getParameterValue(valueParameter, "false"),
			minimal: null,
			low: null,
			medium: null,
			high: getParameterValue(valueParameter, "true"),
			xhigh: null,
			max: null,
		};
	}

	return {
		off:
			getParameterValue(reasoningParameter, "none") ??
			getParameterValue(reasoningParameter, "off") ??
			getParameterValue(thinkingParameter, "false"),
		minimal: mapComparableLevel(valueParameter, "minimal"),
		low: mapComparableLevel(valueParameter, "low"),
		medium: mapComparableLevel(valueParameter, "medium"),
		high: mapComparableLevel(valueParameter, "high"),
		xhigh: mapComparableLevel(valueParameter, "xhigh"),
		max: mapComparableLevel(valueParameter, "max"),
	};
}

function parseContextWindow(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (!Number.isFinite(amount)) return undefined;
	return Math.round(amount * (unit === "m" ? 1000000 : 1000));
}

function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
	if (!item.variants?.length) return [];
	const defaultVariant = item.variants.find((variant) => variant.isDefault) ?? item.variants[0];
	return cloneParams(defaultVariant?.params ?? []);
}

function replaceParam(
	params: ModelParameterValue[],
	id: string,
	value: string,
): ModelParameterValue[] {
	let replaced = false;
	const next = params.map((param) => {
		if (param.id !== id) return { ...param };
		replaced = true;
		return { id, value };
	});
	if (!replaced) next.push({ id, value });
	return next;
}

function getParamValue(params: ModelParameterValue[], id: string): string | undefined {
	return params.find((param) => param.id === id)?.value;
}

function getModelName(item: ModelListItem, context?: string, alias?: string, fastOverride?: boolean): string {
	const displayName = item.displayName || item.id;
	const qualifiers: string[] = [];
	if (alias) qualifiers.push(alias);
	if (fastOverride === true) qualifiers.push("fast");
	if (fastOverride === false) qualifiers.push("slow");
	const baseName = qualifiers.length > 0 ? `${displayName} (${qualifiers.join(", ")})` : displayName;
	return context ? `${baseName} @ ${context}` : baseName;
}

function getContextWindow(
	contextWindowCache: Map<string, number>,
	selectionKeys: readonly string[],
	context?: string,
	baseModelId?: string,
): number {
	for (const key of new Set(selectionKeys)) {
		const contextWindow = contextWindowCache.get(key);
		if (contextWindow !== undefined) return contextWindow;
	}
	return (
		(context ? parseContextWindow(context) : undefined) ??
		(baseModelId ? contextWindowCache.get(baseModelId) : undefined) ??
		contextWindowCache.get("default") ??
		FALLBACK_CONTEXT_WINDOW
	);
}

function toMetadata(
	item: ModelListItem,
	piModelId: string,
	selectionModelId: string,
	defaultParams: ModelParameterValue[],
	context: string | undefined,
	contextWindowCache: Map<string, number>,
	contextWindowKeys: readonly string[],
	fastOverride?: boolean,
): CursorModelMetadata {
	const thinkingLevelMap = getThinkingLevelMap(item);
	const fastValue = getParamValue(defaultParams, "fast")?.toLowerCase();
	return {
		piModelId,
		baseModelId: item.id,
		selectionModelId,
		displayName: item.displayName || item.id,
		defaultParams: cloneParams(defaultParams),
		...(context ? { context } : {}),
		contextWindow: getContextWindow(contextWindowCache, contextWindowKeys, context, item.id),
		supportsFast: getParameter(item, "fast") !== undefined,
		defaultFast: fastValue === "true",
		...(fastOverride !== undefined ? { fastOverride } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		parameterIds: {
			context: getParameter(item, "context") !== undefined,
			reasoning: getParameter(item, "reasoning") !== undefined,
			effort: getParameter(item, "effort") !== undefined,
			reasoningEffort: getParameter(item, "reasoning_effort") !== undefined,
			thinking: getParameter(item, "thinking") !== undefined,
			fast: getParameter(item, "fast") !== undefined,
		},
	};
}

/**
 * OMP-native thinking metadata (ProviderModelConfig.thinking). OMP ignores Pi's
 * `thinkingLevelMap`, invents `minimal..high` for every reasoning model, and clamps
 * `--thinking` against `thinking.efforts` before calling streamSimple. Advertising
 * exactly the efforts Cursor offers keeps the selected level unchanged on its way
 * to buildCursorModelSelection. `requiresEffort` marks models without a Cursor off
 * value; it is explicit either way so OMP does not infer it from the model family.
 */
function toThinkingConfig(thinkingLevelMap: ThinkingLevelMap | undefined): ProviderModelConfig["thinking"] {
	if (!thinkingLevelMap) return undefined;
	const efforts = EFFORT_LEVELS.filter((level) => thinkingLevelMap[level] != null) as readonly Effort[];
	if (efforts.length === 0) return undefined;
	return { mode: "effort", efforts, requiresEffort: thinkingLevelMap.off == null };
}

function toModelConfig(metadata: CursorModelMetadata, name: string): ProviderModelConfig {
	const thinking = toThinkingConfig(metadata.thinkingLevelMap);
	return {
		id: metadata.piModelId,
		name,
		reasoning: thinking !== undefined,
		...(thinking ? { thinking } : {}),
		input: [...TEXT_AND_IMAGE_INPUT],
		cost: { ...ZERO_COST },
		contextWindow: metadata.contextWindow,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

function registerModelItems(items: ModelListItem[]): ProviderModelConfig[] {
	metadataByPiModelId.clear();
	catalogVariantsByBaseModelId.clear();
	const contextWindowCache = loadContextWindowCache();
	return getCursorModelSelectionIdentities(items).map(({ model: item, selectionModelId, context, fastOverride, piModelId, contextWindowKey, baseContextWindowKey }) => {
		const defaultParams = getDefaultParams(item);
		if (item.variants?.length) catalogVariantsByBaseModelId.set(item.id, item.variants);
		const contextParams = context ? replaceParam(defaultParams, "context", context) : defaultParams;
		const params = fastOverride === undefined ? contextParams : replaceParam(contextParams, "fast", fastOverride ? "true" : "false");
		const metadata = toMetadata(
			item,
			piModelId,
			selectionModelId,
			params,
			context,
			contextWindowCache,
			// The fast/slow lane does not change the window (measured: grok-4.6 and
			// grok-4.6@fast are both 256000), so a lane without its own measurement
			// uses the same model + context before falling back to the context label.
			[
				piModelId,
				contextWindowKey,
				baseContextWindowKey,
				encodePiModelId(selectionModelId, context),
				encodePiModelId(item.id, context),
			],
			fastOverride,
		);
		metadataByPiModelId.set(piModelId, metadata);
		const alias = selectionModelId === item.id ? undefined : selectionModelId;
		return toModelConfig(metadata, getModelName(item, context, alias, fastOverride));
	});
}

export function getCursorModelMetadata(modelId: string): CursorModelMetadata | undefined {
	return metadataByPiModelId.get(modelId);
}

export function getCursorModelMetadataEntries(): CursorModelMetadata[] {
	return [...metadataByPiModelId.values()].map((metadata) => ({
		...metadata,
		defaultParams: cloneParams(metadata.defaultParams),
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
		parameterIds: { ...metadata.parameterIds },
	}));
}

/**
 * The largest catalog context value of `selectionModelId` that is smaller than `context`
 * (e.g. "256k" for grok-4.7 refused at "500k"), or undefined when there is none.
 */
export function getSmallerCursorContextVariant(selectionModelId: string, context: string): string | undefined {
	const refused = parseContextWindow(context);
	if (refused === undefined) return undefined;
	let best: { context: string; size: number } | undefined;
	for (const metadata of metadataByPiModelId.values()) {
		if (metadata.selectionModelId !== selectionModelId || !metadata.context) continue;
		const size = parseContextWindow(metadata.context);
		if (size !== undefined && size < refused && (!best || size > best.size)) best = { context: metadata.context, size };
	}
	return best?.context;
}

function matchingCatalogVariants(variants: readonly ModelVariant[], params: readonly ModelParameterValue[]): ModelVariant[] {
	return variants.filter((variant) =>
		params.every((wanted) =>
			variant.params.some((candidate) => candidate.id.trim() === wanted.id.trim() && candidate.value.trim() === wanted.value.trim()),
		),
	);
}

function areAllMatchingVariantsMaxMode(variants: readonly ModelVariant[], params: readonly ModelParameterValue[]): boolean {
	if (params.length === 0) return false;
	const matching = matchingCatalogVariants(variants, params);
	return matching.length > 0 && matching.every((variant) => variant.isMaxMode === true);
}

/**
 * Whether the catalog lists every variant matching `selection` as Max Mode only (`ModelVariant.isMaxMode`).
 * This is the rule @cursor/sdk 1.0.40 applies in its local catalog resolver, which then sends `maxMode`
 * whatever the caller asked for. False when the catalog has no variant information for the model, so
 * a model discovered without variants is never reported as Max Mode only.
 */
export function isCursorSelectionMaxModeOnly(piModelId: string, selection: ModelSelection): boolean {
	const metadata = metadataByPiModelId.get(piModelId);
	const variants = metadata ? catalogVariantsByBaseModelId.get(metadata.baseModelId) : undefined;
	return variants !== undefined && areAllMatchingVariantsMaxMode(variants, selection.params ?? []);
}

/**
 * Registered ids of the same model, in the same selection form, that a Max Mode only `selection` could be
 * swapped for: the context and fast lane change, every other parameter stays, and the catalog lists the
 * resulting variant without marking it Max Mode only.
 */
export function getCursorNonMaxModeAlternatives(piModelId: string, selection: ModelSelection): string[] {
	const metadata = metadataByPiModelId.get(piModelId);
	const variants = metadata ? catalogVariantsByBaseModelId.get(metadata.baseModelId) : undefined;
	if (!metadata || !variants) return [];
	// One entry per variant. `@256k` and `@256k@fast` select the same variant when 256k's default lane is fast;
	// the explicit lane id is listed, because it keeps that variant when a /cursor-fast preference changes the lane.
	const byVariant = new Map<string, { id: string; explicitLane: boolean }>();
	for (const candidate of metadataByPiModelId.values()) {
		if (
			candidate.piModelId === piModelId ||
			candidate.baseModelId !== metadata.baseModelId ||
			candidate.selectionModelId !== metadata.selectionModelId
		) {
			continue;
		}
		let params = cloneParams(selection.params ?? []);
		if (candidate.context) params = replaceParam(params, "context", candidate.context);
		if (candidate.fastOverride !== undefined) params = replaceParam(params, "fast", candidate.fastOverride ? "true" : "false");
		if (matchingCatalogVariants(variants, params).length === 0 || areAllMatchingVariantsMaxMode(variants, params)) continue;
		const variantKey = JSON.stringify(params);
		const explicitLane = candidate.fastOverride !== undefined;
		if (!byVariant.get(variantKey)?.explicitLane) byVariant.set(variantKey, { id: candidate.piModelId, explicitLane });
	}
	return [...byVariant.values()].map((entry) => entry.id);
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
	const existing = params.find((param) => param.id === id);
	if (existing) {
		existing.value = value;
	} else {
		params.push({ id, value });
	}
}

function deleteParam(params: ModelParameterValue[], id: string): void {
	const index = params.findIndex((param) => param.id === id);
	if (index >= 0) params.splice(index, 1);
}

function applyThinkingLevel(
	metadata: CursorModelMetadata,
	params: ModelParameterValue[],
	level: ModelThinkingLevel,
): void {
	const mapped = metadata.thinkingLevelMap?.[level];
	if (mapped === undefined || mapped === null) return;
	// The catalog names the effort control `effort` (Claude Opus) or `reasoning_effort` (Claude Haiku 5.5,
	// grok-4.7, gemini-3.8-flash); a model exposes at most one of them.
	const effortId = metadata.parameterIds.effort
		? "effort"
		: metadata.parameterIds.reasoningEffort
			? "reasoning_effort"
			: undefined;

	if (level === "off") {
		if (metadata.parameterIds.thinking && mapped === "false") {
			setParam(params, "thinking", mapped);
			if (effortId) deleteParam(params, effortId);
			return;
		}
		if (metadata.parameterIds.reasoning) {
			setParam(params, "reasoning", mapped);
		}
		return;
	}

	if (effortId) {
		if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
		setParam(params, effortId, mapped);
		return;
	}

	if (metadata.parameterIds.reasoning) {
		setParam(params, "reasoning", mapped);
		return;
	}

	if (metadata.parameterIds.thinking) {
		setParam(params, "thinking", mapped);
	}
}

export function buildCursorModelSelection(
	modelId: string,
	thinkingLevel: ModelThinkingLevel,
	fastEnabled?: boolean,
): ModelSelection {
	const metadata = getCursorModelMetadata(modelId);
	if (!metadata) return { id: modelId };

	const params = cloneParams(metadata.defaultParams);
	applyThinkingLevel(metadata, params, thinkingLevel);

	if (metadata.supportsFast && fastEnabled !== undefined) {
		setParam(params, "fast", fastEnabled ? "true" : "false");
	}

	return params.length > 0 ? { id: metadata.selectionModelId, params } : { id: metadata.selectionModelId };
}

function sanitizeDiscoveryError(error: unknown, apiKey: string): string | undefined {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return scrubSensitiveText(message, apiKey).trim() || undefined;
}

async function useFallbackModels(options: DiscoverModelsOptions, issue: CursorModelFallbackIssue): Promise<ProviderModelConfig[]> {
	options.onFallback?.(issue);
	const { FALLBACK_MODEL_ITEMS } = await import("./cursor-fallback-models.generated.js");
	return registerModelItems(FALLBACK_MODEL_ITEMS);
}

export async function discoverModels(options: DiscoverModelsOptions = {}): Promise<ProviderModelConfig[]> {
	const apiKey = await getDiscoveryApiKey(options.apiKey);
	if (!apiKey) {
		return useFallbackModels(options, {
			reason: "missing-api-key",
			message: `Cursor model discovery needs a Cursor SDK API key. Using fallback Cursor models so model selection still works; they can run once the key is set. ${AUTH_SETUP_HINT}`,
		});
	}

	const keyFingerprint = fingerprintApiKey(apiKey);

	if (!options.forceRefresh) {
		const cachedModels = loadFreshCachedModels(keyFingerprint);
		if (cachedModels && cachedModels.length > 0) {
			return registerModelItems(cachedModels);
		}
		// Startup efficiency: prefer a stale cached catalog over importing the
		// SDK (+~94MB RSS + network round-trip) just because the TTL lapsed.
		// Sessions that never run a Cursor model must not pay the SDK import;
		// the catalog refreshes on demand (a Cursor turn or
		// /cursor-refresh-models). Model ids are validated by the SDK at run
		// time, so a stale catalog is safe to serve until then.
		const staleCatalog = loadAnyCachedModelCatalog(keyFingerprint);
		if (staleCatalog && staleCatalog.models.length > 0) {
			return registerModelItems(staleCatalog.models);
		}
	}

	try {
		const { Cursor } = await loadCursorSdk();
		const models = await Cursor.models.list({ apiKey });
		if (models.length > 0) {
			saveModelListCache(keyFingerprint, models);
			return registerModelItems(models);
		}
		return useFallbackModels(options, {
			reason: "empty-model-list",
			message: `Cursor model discovery returned no models. Using fallback Cursor models. ${AUTH_SETUP_HINT}`,
		});
	} catch (error) {
		const errorMessage = sanitizeDiscoveryError(error, apiKey);
		// Prefer a previously cached catalog over the generic bundled fallback when
		// a live refresh fails (e.g. transient network/auth errors), but keep the
		// provenance visible so refresh commands do not claim a live refresh worked.
		const cachedCatalog = loadAnyCachedModelCatalog(keyFingerprint);
		if (cachedCatalog && cachedCatalog.models.length > 0) {
			options.onFallback?.({
				reason: "cached-after-error",
				message: `Cursor model discovery failed; using cached Cursor model catalog from ${new Date(cachedCatalog.fetchedAt).toISOString()}.${errorMessage ? ` ${errorMessage}` : ""}`,
				...(errorMessage ? { errorMessage } : {}),
			});
			return registerModelItems(cachedCatalog.models);
		}
		return useFallbackModels(options, {
			reason: "discovery-failed",
			message: `Cursor model discovery failed${errorMessage ? `: ${errorMessage}` : ""}. Using fallback Cursor models. ${AUTH_SETUP_HINT}`,
			...(errorMessage ? { errorMessage } : {}),
		});
	}
}

export const __testUtils = {
	parseContextWindow,
	registerModelItems,
	normalizeApiKey: resolveCursorApiKey,
};
