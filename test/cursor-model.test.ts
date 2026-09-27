import { describe, expect, it, vi } from "vitest";
import { isCursorModel } from "../src/cursor-model.js";
import { registerCursorFallbackIssueWarning } from "../src/cursor-fallback-warning.js";
import { createHarnessEventApi } from "./helpers/event-harness.js";
import { makeHarnessModel } from "./helpers/model-fixtures.js";

// Shape of a row from OMP 18.3.4's built-in Cursor provider (pi-catalog
// discovery/cursor.ts: provider "cursor", api "cursor-agent").
const builtInCursorModel = makeHarnessModel("cursor", "cursor-agent", "grok-4.7-high");
const pluginCursorModel = makeHarnessModel("cursor-sdk", "cursor-sdk", "grok-4.7@256k");

describe("plugin Cursor model recognition", () => {
	it("recognizes its own rows, not OMP's built-in `cursor` rows", () => {
		expect(isCursorModel(pluginCursorModel)).toBe(true);
		expect(isCursorModel(builtInCursorModel)).toBe(false);
	});

	it("does not run Cursor-only lifecycle hooks for built-in `cursor/...` models", async () => {
		const events = createHarnessEventApi();
		registerCursorFallbackIssueWarning(events, { reason: "missing-api-key", message: "fallback catalog" });

		const notify = vi.fn();
		await events.runSessionStart({ model: builtInCursorModel, ui: { notify } as never });
		await events.runTurnStart({ model: builtInCursorModel, ui: { notify } as never });
		expect(notify).not.toHaveBeenCalled();

		await events.runTurnStart({ model: pluginCursorModel, ui: { notify } as never });
		expect(notify).toHaveBeenCalledWith("fallback catalog", "warning");
	});
});
