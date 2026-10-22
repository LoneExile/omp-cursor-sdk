import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cursorExtension from "../src/index.js";
import { __testUtils } from "../src/cursor-sdk-output-filter.js";
import { createExtensionPi, resetIndexExtensionTestState } from "./helpers/index-extension-test-kit.js";
import { CONSOLE_METHODS, captureProcessOutput, type ProcessOutputCapture } from "./helpers/process-output-capture.js";

function members(): unknown[] {
	return [process.stdout.write, process.stderr.write, ...CONSOLE_METHODS.map((method) => console[method])];
}

// The process-lifetime SDK output filter is taken by the first `loadCursorSdk()`, because SDK noise cannot
// exist before the SDK is loaded (test/cursor-tree-sitter-vendor-dir.test.ts runs a first load in a fresh
// process and observes the lease before the SDK evaluates). Extension initialization must not take it: a
// session that never loads the SDK keeps omp's own stdout/stderr/console untouched.
describe("extension initialization output filter", () => {
	let capture: ProcessOutputCapture;

	beforeEach(async () => {
		__testUtils.resetProcessOutputFilter();
		await resetIndexExtensionTestState();
		capture = captureProcessOutput();
	});

	afterEach(async () => {
		__testUtils.resetProcessOutputFilter();
		capture.restore();
		await resetIndexExtensionTestState();
	});

	it("leaves process output unwrapped across the factory, repeated registrations and session start", async () => {
		const before = members();
		const pi = createExtensionPi();
		await cursorExtension(pi);
		// omp re-runs the factory for every in-process subagent registration.
		await cursorExtension(createExtensionPi());
		await pi.runSessionStart();

		const after = members();
		expect(after).toHaveLength(before.length);
		after.forEach((member, index) => expect(member).toBe(before[index]));
	});
});
