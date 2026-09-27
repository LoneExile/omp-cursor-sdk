import type { ModelListItem } from "@cursor/sdk";

export interface CursorModelSelectionIdentity {
	model: ModelListItem;
	selectionModelId: string;
	context?: string;
	fastOverride?: boolean;
	piModelId: string;
	contextWindowKey: string;
	baseContextWindowKey: string;
}

/** Canonical pi model id: `<id>[@<context>][@fast|@slow]`. */
export declare function encodePiModelId(modelId: string, context?: string, fastOverride?: boolean): string;

export declare function getCursorModelSelectionIdentities(
	models: readonly ModelListItem[],
): CursorModelSelectionIdentity[];

export declare function normalizeCursorContextWindowEntries(
	models: readonly ModelListItem[],
	entries: ReadonlyMap<string, number>,
	source?: string,
): Map<string, number>;
