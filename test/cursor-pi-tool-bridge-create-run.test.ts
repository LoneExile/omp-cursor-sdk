import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CursorPiToolBridgeRegistry } from "../src/cursor-pi-tool-bridge-server.js";
import { createTestToolInfo } from "./helpers/tool-fixtures.js";

describe("Cursor pi tool bridge createRun", () => {
	it("forgets the run and closes its MCP server when the run fails to start", async () => {
		const pi = { getActiveTools: () => ["custom_read"], getAllTools: () => [createTestToolInfo("custom_read")] };
		const registry = new CursorPiToolBridgeRegistry(pi as never, { PI_CURSOR_PI_TOOL_BRIDGE: "1" });
		const closeMcpServer = vi.spyOn(McpProtocolServer.prototype, "close");
		const originalListen = Server.prototype.listen;
		Server.prototype.listen = function (this: Server) {
			queueMicrotask(() => this.emit("error", new Error("injected listen failure")));
			return this;
		} as typeof Server.prototype.listen;
		let mcpServerCloses: number;
		try {
			await expect(registry.createRun()).rejects.toThrow("injected listen failure");
			mcpServerCloses = closeMcpServer.mock.calls.length;
		} finally {
			Server.prototype.listen = originalListen;
			closeMcpServer.mockRestore();
		}
		expect(mcpServerCloses).toBe(1);
		// Private run set: a stale failed run would stay visible to pending-call lookups.
		const runs: Set<unknown> = Reflect.get(registry, "runs");
		expect(runs.size).toBe(0);
		expect(registry.getEndpointCount()).toBe(0);
	});
});
