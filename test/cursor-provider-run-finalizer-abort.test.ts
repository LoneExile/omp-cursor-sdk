import { describe, expect, it, vi } from "vitest";
import { CursorRunFinalizer } from "../src/cursor-provider-run-finalizer.js";

describe("Cursor live-run abort listener lifetime", () => {
	it("removes the abort listener only after a pending live run settles", async () => {
		const controller = new AbortController();
		const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
		const listener = () => {};
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
		expect(removeEventListener).not.toHaveBeenCalled();

		settle();
		await waitCompletion;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(removeEventListener).toHaveBeenCalledWith("abort", listener);
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});
});
