/**
 * One INFO frame as printed by the installed @cursor/sdk 1.0.34 logger. cursor-sdk-output-filter-contract.test.ts
 * regenerates it with the SDK's own printer (colors on and off, timestamp normalized) and fails when this drifts, so
 * behavior tests can use the literals without re-deriving them.
 */
export const SAMPLE_INFO_CALL = {
	ctx: "loadRules",
	message: "LocalCursorRulesService load completed",
	metadata: { durationMs: 12, ruleCount: 3 },
} as const;

export const SAMPLE_INFO_TIMESTAMP = "02:23:21.606";

export const COLORED_INFO_FRAME =
	"\u001b[2m02:23:21.606\u001b[0m \u001b[34mINFO \u001b[0m LocalCursorRulesService load completed \u001b[2mctx=loadRules\u001b[0m \u001b[2mmeta=\u001b[0m\u001b[2m{\u001b[0m\u001b[36mdurationMs\u001b[0m: \u001b[33m12\u001b[0m\u001b[2m, \u001b[0m\u001b[36mruleCount\u001b[0m: \u001b[33m3\u001b[0m\u001b[2m}\u001b[0m";

export const PLAIN_INFO_FRAME =
	"02:23:21.606 INFO  LocalCursorRulesService load completed ctx=loadRules meta={durationMs: 12, ruleCount: 3}";
