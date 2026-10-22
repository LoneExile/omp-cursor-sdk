import type { ModelSelection } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-config.js";
import { CURSOR_PROVIDER } from "./cursor-model.js";
import { getCursorNonMaxModeAlternatives, isCursorSelectionMaxModeOnly } from "./model-discovery.js";

const MAX_ALTERNATIVES_LISTED = 4;

/**
 * Apply the Cursor Max Mode toggle to a model selection.
 *
 * `@cursor/sdk` 1.0.40 carries Max Mode natively as `ModelSelection.maxMode` and copies it onto the
 * local agent's request. A disabled toggle returns the selection untouched.
 */
export function applyCursorMaxModeSelection(selection: ModelSelection, enabled: boolean): ModelSelection {
	if (!enabled || selection.maxMode === true) return selection;
	return { ...selection, maxMode: true };
}

function formatSelectionParams(selection: ModelSelection): string {
	return (selection.params ?? []).map((param) => `${param.id}=${param.value}`).join(", ");
}

function formatAvoidanceAdvice(piModelId: string, selection: ModelSelection): string {
	const alternatives = getCursorNonMaxModeAlternatives(piModelId, selection).slice(0, MAX_ALTERNATIVES_LISTED);
	return alternatives.length > 0
		? `pick a variant that does not need it: ${alternatives.map((id) => `${CURSOR_PROVIDER}/${id}`).join(", ")}`
		: "pick another variant of this model that Cursor does not list as Max Mode only";
}

export function formatCursorMaxModeOnlyRefusal(piModelId: string, selection: ModelSelection): string {
	return (
		`Cursor Max Mode is off, but ${CURSOR_PROVIDER}/${piModelId} selects a variant Cursor lists as Max Mode only (${formatSelectionParams(selection)}). ` +
		`@cursor/sdk would run it in Max Mode and bill Max Mode rates anyway, so this turn was not sent. ` +
		`Turn Max Mode on (--cursor-max-mode, /cursor-max-mode on, or PI_CURSOR_MAX_MODE=1), or ${formatAvoidanceAdvice(piModelId, selection)}.`
	);
}

/**
 * The warning for turning Max Mode off while the current local model is Max Mode only, or undefined when
 * that model's next turn would not be refused.
 */
export function formatCursorMaxModeOffWarning(piModelId: string, selection: ModelSelection): string | undefined {
	if (!isCursorSelectionMaxModeOnly(piModelId, selection)) return undefined;
	return (
		`${CURSOR_PROVIDER}/${piModelId} is a variant Cursor lists as Max Mode only, so its next turn will be refused while Max Mode is off. ` +
		`Turn Max Mode back on, or ${formatAvoidanceAdvice(piModelId, selection)}.`
	);
}

/**
 * The model selection a turn sends for the Max Mode setting.
 *
 * - Cursor Cloud: the selection unchanged. The Cloud Agents API's model object (`ModelRef`) has only `id` and
 *   `params`, and it rejects any other key (a run request carrying `maxMode` answers 400 `validation_error:
 *   Unrecognized key(s) in object: 'maxMode'`), while @cursor/sdk 1.0.40 passes the selection to the REST
 *   request whole. The toggle has no effect on a Cloud turn.
 * - Local, toggle on: `maxMode: true`.
 * - Local, toggle off: the selection unchanged, unless the catalog lists every variant matching it as Max
 *   Mode only. `@cursor/sdk` 1.0.40 then sets `maxMode` itself and bills Max Mode rates, which the user
 *   switched off, so that selection is refused before any agent exists. A model whose catalog has no variant
 *   information is never refused.
 */
export function selectCursorMaxModeSelection(
	piModelId: string,
	selection: ModelSelection,
	options: { runtime: CursorRuntime; enabled: boolean },
): ModelSelection {
	if (options.runtime === "cloud") return selection;
	if (options.enabled) return applyCursorMaxModeSelection(selection, true);
	if (isCursorSelectionMaxModeOnly(piModelId, selection)) {
		throw new Error(formatCursorMaxModeOnlyRefusal(piModelId, selection));
	}
	return selection;
}
