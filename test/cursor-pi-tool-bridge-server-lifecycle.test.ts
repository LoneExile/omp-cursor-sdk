import { describe, expect, it } from "vitest";
import { request, Server } from "node:http";
import { CursorPiToolBridgeRegistry } from "../src/cursor-pi-tool-bridge-server.js";
import type { CursorPiToolBridgeRunImpl } from "../src/cursor-pi-tool-bridge-run.js";

function createRegistry(): CursorPiToolBridgeRegistry {
	return new CursorPiToolBridgeRegistry({ getActiveSkills: () => [], getTools: () => [] } as any, {
		PI_CURSOR_PI_TOOL_BRIDGE: "1",
	});
}

function fakeRun(body: string): CursorPiToolBridgeRunImpl {
	return {
		handleHttpRequest: async (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(body);
		},
	} as unknown as CursorPiToolBridgeRunImpl;
}

function get(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = request(url, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve(body));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("Cursor pi tool bridge HTTP server lifecycle", () => {
	it("recovers after a real listen failure without resetting registry state", async () => {
		const registry = createRegistry();
		const originalListen = Server.prototype.listen;
		let failed = false;
		Server.prototype.listen = function (...args: any[]) {
			if (!failed) {
				failed = true;
				queueMicrotask(() => this.emit("error", new Error("injected listen failure")));
				return this;
			}
			return originalListen.apply(this, args as any);
		} as typeof Server.prototype.listen;
		try {
			await expect(registry.registerRun("/failed", fakeRun("failed"))).rejects.toThrow("injected listen failure");
		} finally {
			Server.prototype.listen = originalListen;
		}
		expect(registry.getEndpointCount()).toBe(0);
		const run = fakeRun("ok");
		const endpoint = await registry.registerRun("/recovered", run);
		expect(await get(endpoint)).toBe("ok");
		await registry.unregisterRun("/recovered", run);
		expect(registry.getHttpServerAddress()).toBeUndefined();
	});

	it("keeps a same-tick concurrent registration alive while closing the old run", async () => {
		const registry = createRegistry();
		const runA = fakeRun("A");
		const runB = fakeRun("B");
		await registry.registerRun("/a", runA);
		const pB = registry.registerRun("/b", runB);
		const pA = registry.unregisterRun("/a", runA);
		await pA;
		const endpointB = await pB;
		expect(await get(endpointB)).toBe("B");
		await registry.unregisterRun("/b", runB);
		expect(registry.getHttpServerAddress()).toBeUndefined();
	});
});
