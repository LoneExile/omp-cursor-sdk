import { describe, expect, it } from "vitest";
import { CursorRunFinalizer } from "../src/cursor-provider-run-finalizer.js";

describe("Cursor live-run abort listener lifetime", () => {
	it("keeps the abort listener until a pending live run settles", async () => {
		const controller = new AbortController();
		let cancelCount = 0;
		const listener = () => { cancelCount += 1; };
		controller.signal.addEventListener("abort", listener);
		let settle!: () => void;
		const waitCompletion = new Promise<void>((resolve) => { settle = resolve; });
		const finalizer = new CursorRunFinalizer({
			runnerParams: { sdkEventDebugRef: { current: undefined } } as any,
			sdkEventDebug: () => undefined,
			sdkProcessErrorGuard: { dispose() {} } as any,
			resolvedApiKey: () => undefined,
			runtimeTarget: () => "local",
		} as any);
		await finalizer.cleanup(undefined, { abortRegistration: { signal: controller.signal, listener } } as any, { waitCompletion } as any);
		controller.abort();
		expect(cancelCount).toBe(1);
		settle();
		await waitCompletion;
		await Promise.resolve();
		await Promise.resolve();
		const countAfterSettlement = cancelCount;
		controller.abort();
		expect(cancelCount).toBe(countAfterSettlement);
	});
});
