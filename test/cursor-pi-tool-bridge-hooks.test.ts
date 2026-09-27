import { describe, expect, it } from "vitest";
import { registerCursorPiToolBridge } from "../src/cursor-pi-tool-bridge.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";

// omp turns off speculative local-read tool execution while any extension handles tool_call
// or tool_result (pi-coding-agent speculation/host.ts hasLifecycleHandlers). The bridge must
// not register those at load, only once a Cursor run actually exposes pi tools.
describe("Cursor pi tool bridge host hooks", () => {
	it("registers tool_call/tool_result only on the first run that exposes pi tools", async () => {
		const events: string[] = [];
		const pi = {
			on: (event: string) => {
				events.push(event);
			},
			getActiveTools: () => ["custom_read"],
			getAllTools: () => [createTestToolInfo("custom_read")],
		};
		const bridge = registerCursorPiToolBridge(pi as never);
		expect(events).toEqual(["turn_end", "session_shutdown"]);

		const first = await bridge.createRun();
		const second = await bridge.createRun();
		expect(first.enabled).toBe(true);
		expect(events.filter((event) => event === "tool_call")).toHaveLength(1);
		expect(events.filter((event) => event === "tool_result")).toHaveLength(1);
		await first.dispose();
		await second.dispose();
	});
});
