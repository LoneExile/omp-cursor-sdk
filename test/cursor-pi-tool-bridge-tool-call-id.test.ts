import { describe, expect, it } from "vitest";
import {
	CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH,
	buildCursorPiBridgeToolCallId,
	isCursorPiBridgeToolCallId,
} from "../src/cursor-pi-tool-bridge-constants.js";

describe("cursor pi bridge provider-facing tool call IDs", () => {
	it("builds bounded IDs that stay unique per counter in one run", () => {
		const runUuid = "c2417032-9686-40f2-bd3c-a763fbaa7693";
		const tenthId = buildCursorPiBridgeToolCallId(runUuid, 10);
		const thirdDigitIndexId = buildCursorPiBridgeToolCallId(runUuid, 100);

		expect(tenthId).toBe("cursor-pi-bridge-c2417032968640f2bd3ca763fbaa7693-t10");
		expect(tenthId.length).toBeLessThanOrEqual(CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH);
		expect(thirdDigitIndexId).toMatch(/-t100$/);
		expect(thirdDigitIndexId.length).toBeLessThanOrEqual(CURSOR_PI_BRIDGE_TOOL_CALL_ID_MAX_LENGTH);
		expect(isCursorPiBridgeToolCallId(tenthId)).toBe(true);
		expect(isCursorPiBridgeToolCallId("cursor-pi-bridge-run-c2417032-9686-40f2-bd3c-a763fbaa7693-tool-10")).toBe(true);
	});

	it("rejects IDs longer than the OpenAI-compatible limit", () => {
		const runUuid = "c2417032-9686-40f2-bd3c-a763fbaa7693";
		expect(() => buildCursorPiBridgeToolCallId(runUuid, 10_000_000_000_000)).toThrow(
			"Cursor pi bridge tool call ID limit exceeded",
		);
	});
});
