import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_API_KEY_CONFIG_VALUE,
	resolveCursorApiKey,
	resolveCursorRuntimeApiKey,
} from "../src/cursor-api-key.js";

describe("cursor-api-key helpers", () => {
	const originalEnv = process.env;
	const originalArgv = process.argv;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.CURSOR_API_KEY;
		process.argv = ["node", "vitest"];
	});

	afterEach(() => {
		process.env = originalEnv;
		process.argv = originalArgv;
	});

	it.each(["CURSOR_API_KEY", "$CURSOR_API_KEY", "${CURSOR_API_KEY}", CURSOR_API_KEY_CONFIG_VALUE])(
		"resolves placeholder %s through env only",
		(placeholder) => {
			expect(resolveCursorApiKey(placeholder)).toBeUndefined();
			process.env.CURSOR_API_KEY = "env-key-123";
			expect(resolveCursorApiKey(placeholder)).toBe("env-key-123");
		},
	);

	it("ignores every process argv form and resolves the runtime key from env", async () => {
		process.argv = [
			"node", "pi", "--model", "anthropic/first", "--api-key", "first-key",
			"--MODEL", "cursor-sdk/case", "--API-KEY", "case-key",
			"--model=cursor-sdk/unsupported", "--api-key=equals-key",
			"--models", "cursor-sdk/list-like", "--provider", "cursor-sdk",
			"--model", "cursor-sdk/final", "--api-key", "last-key",
		];
		expect(await resolveCursorRuntimeApiKey()).toBeUndefined();

		process.env.CURSOR_API_KEY = "env-key-123";
		expect(await resolveCursorRuntimeApiKey()).toBe("env-key-123");
	});

	it("resolves the configured placeholder through env", async () => {
		process.env.CURSOR_API_KEY = "env-key-123";

		expect(resolveCursorApiKey(CURSOR_API_KEY_CONFIG_VALUE)).toBe("env-key-123");
		expect(await resolveCursorRuntimeApiKey()).toBe("env-key-123");
	});
});
