import { describe, expect, it } from "vitest";
import { createDetachedCursorSessionBinding, runInCursorSessionBinding } from "../src/cursor-session-binding.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { createPiHarness } from "./helpers/pi-harness.js";

const AGENT = "bc-00000000-0000-0000-0000-000000000001";

function complete(command: string, prefix: string): string[] | null {
	const pi = createPiHarness();
	runInCursorSessionBinding(createDetachedCursorSessionBinding(), () => registerCursorRuntimeControls(pi));
	const options = pi._commands.get(command);
	if (!options?.getArgumentCompletions) throw new Error(`/${command} has no argument completions`);
	return options.getArgumentCompletions(prefix)?.map((item) => item.value) ?? null;
}

describe("/cursor-* argument completions", () => {
	it("offers each command's first word and narrows it by case-insensitive prefix", () => {
		expect(complete("cursor-http", "")).toEqual(["on", "off", "toggle"]);
		expect(complete("cursor-http", "O")).toEqual(["on", "off"]);
		expect(complete("cursor-mode", "p")).toEqual(["plan"]);
		expect(complete("cursor-max-mode", "t")).toEqual(["toggle"]);
		expect(complete("cursor-local-resume-cleanup", "--")).toEqual(["--dry-run", "--yes"]);
		expect(complete("cursor-cloud", "")).toEqual(["list", "archive ", "delete "]);
		expect(complete("cursor-http", "x")).toBeNull();
	});

	it("completes a later word with the whole argument text, which omp puts in place of what was typed", () => {
		expect(complete("cursor-runtime", "local --save-p")).toEqual(["local --save-project"]);
		expect(complete("cursor-max-mode", "on --")).toEqual(["on --save-user"]);
		expect(complete("cursor-cloud", `delete ${AGENT} `)).toEqual([`delete ${AGENT} --yes`]);
	});

	it("offers nothing past the arguments a command accepts or after an invalid earlier word", () => {
		expect(complete("cursor-http", "on ")).toBeNull();
		expect(complete("cursor-runtime", "remote ")).toBeNull();
		expect(complete("cursor-max-mode", "maybe --")).toBeNull();
		expect(complete("cursor-cloud", "delete bc-not-an-agent ")).toBeNull();
		expect(complete("cursor-cloud", `archive ${AGENT} `)).toBeNull();
	});
});
