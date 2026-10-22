/**
 * The comment header above `BUNDLED_CONTEXT_WINDOWS` in `src/bundled-context-windows.ts`.
 * `scripts/refresh-cursor-model-snapshots.mjs` writes it on every refresh and
 * `test/model-discovery-selection.test.ts` compares the checked-in file against it, so a
 * refresh cannot silently revert what the header says about Max Mode.
 */
export function formatBundledContextWindowsHeader(date) {
	return [
		`// Generated from Cursor SDK checkpoint tokenDetails.maxTokens on ${date}.`,
		"// Refresh with: npm run refresh:cursor-snapshots -- --write --context-windows ~/.omp/agent/cursor-sdk-context-windows.json",
		"// Keys are current selectable model IDs. Equivalent default :fast/:slow selections",
		"// collapse to one key; stale and ambiguous aliases are omitted. Values are observed",
		"// or conservative default limits and may override a catalog context label when the",
		"// completed SDK checkpoint reports a different effective limit.",
		"// @cursor/sdk 1.0.40 runs every variant the catalog lists as Max Mode only (ModelVariant.isMaxMode,",
		"// for example every `@1m` variant the catalog lists) in Max Mode on its own, so those windows do not",
		"// depend on the Max Mode toggle. A variant the catalog does not list is not forced to Max Mode, so it",
		"// runs at the non-Max window and keeps an explicit conservative row (the `@1m@fast` lanes of gpt-5.4,",
		"// gpt-5.5 and gpt-5-5).",
		"",
	].join("\n");
}
