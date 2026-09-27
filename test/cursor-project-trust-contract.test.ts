import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "@oh-my-pi/pi-coding-agent";
import {
	collectEvents,
	getErrorEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";

const packageRoot = process.cwd();
const piCli = resolve("node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");

type PiMode = "print" | "json" | "rpc";
type MarkerEvent = {
	event: string;
	mode?: string;
	hasUI?: boolean;
	trusted?: boolean;
	runtime?: string;
	runtimeSource?: string;
	acknowledged?: boolean;
	acknowledgementSource?: string;
};

describe("non-interactive project trust CLI/provider contract", () => {
	let fixtureRoot: string;
	let packedPackageRoot: string;
	let probeExtensionPath: string;
	let runRoot: string;
	let projectDir: string;
	let agentDir: string;
	let markerPath: string;

	beforeAll(() => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "pi-cursor-project-trust-package-"));
		const packDir = join(fixtureRoot, "pack");
		const extractDir = join(fixtureRoot, "extract");
		mkdirSync(packDir);
		mkdirSync(extractDir);
		const npmCli = process.env.npm_execpath;
		const packArgs = ["pack", "--silent", "--pack-destination", packDir];
		const pack = npmCli
			? spawnSync(process.execPath, [npmCli, ...packArgs], {
					cwd: packageRoot,
					encoding: "utf8",
					timeout: 60_000,
				})
			: spawnSync("npm", packArgs, {
					cwd: packageRoot,
					encoding: "utf8",
					shell: process.platform === "win32",
					timeout: 60_000,
				});
		expect(pack.error).toBeUndefined();
		expect(pack.status, pack.stderr).toBe(0);
		const tarballName = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
		expect(tarballName).toBeTruthy();
		const extract = spawnSync("tar", ["-xzf", `pack/${tarballName}`, "-C", "extract"], {
			cwd: fixtureRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(extract.error).toBeUndefined();
		expect(extract.status, extract.stderr).toBe(0);
		packedPackageRoot = join(extractDir, "package");
		expect(existsSync(join(packedPackageRoot, "src", "index.ts"))).toBe(true);
		probeExtensionPath = join(packedPackageRoot, "src", "project-trust-contract-probe.ts");
		writeFileSync(probeExtensionPath, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import cursorExtension from "./index.js";
import { resolveCursorProviderTurnConfig } from "./cursor-provider-turn-prepare.js";
const mark = (event: unknown) => appendFileSync(process.env.PI_CURSOR_CONTRACT_MARKER!, JSON.stringify(event) + "\\n");
export default async function (pi: any) {
	pi.on("project_trust", (event: any) => {
		mark({ event: "project_trust", cwd: event.cwd });
		return { trusted: "undecided" };
	});
	pi.on("session_start", (_event: unknown, ctx: any) => {
		if (process.env.PI_CURSOR_CONTRACT_ADD_TRUST_RESOURCE_AT_SESSION_START === "1") {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
			writeFileSync(join(ctx.cwd, ".pi", "settings.json"), "{}\\n");
		}
		mark({ event: "session_start", mode: ctx.mode, hasUI: ctx.hasUI, trusted: ctx.isProjectTrusted?.() === true });
		ctx.ui.confirm = async (title: string) => {
			mark({ event: "ui_confirm", title });
			return false;
		};
	});
	await cursorExtension(pi);
	pi.on("before_agent_start", () => {
		const config = resolveCursorProviderTurnConfig(process.cwd());
		mark({
			event: "provider_config",
			runtime: config.runtime.value,
			runtimeSource: config.runtime.source,
			acknowledged: config.cloud.acknowledged.value,
			acknowledgementSource: config.cloud.acknowledged.source,
		});
	});
}
`);
		const packageJsonPath = join(packedPackageRoot, "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { pi?: { extensions?: string[] } };
		packageJson.pi = { ...packageJson.pi, extensions: ["./src/project-trust-contract-probe.ts"] };
		writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
	}, 120_000);

	beforeEach(async () => {
		await resetCursorProviderTestState();
		runRoot = mkdtempSync(join(tmpdir(), "pi-cursor-project-trust-run-"));
		projectDir = join(runRoot, "project");
		agentDir = join(runRoot, "agent");
		markerPath = join(runRoot, "events.jsonl");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".pi", "cursor-sdk.json"),
			JSON.stringify({ runtime: "cloud", cloud: { acknowledged: true } }),
		);
	});

	afterEach(() => {
		rmSync(runRoot, { recursive: true, force: true });
	});

	afterAll(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	});

	function runPi(
		mode: PiMode,
		trusted?: boolean,
		addTrustResourceAtSessionStart = false,
		projectLocalPackage = false,
	): { output: string; events: MarkerEvent[] } {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name !== "CURSOR_API_KEY" && !name.startsWith("PI_CURSOR_")),
		);
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agentDir,
			PI_CURSOR_CONTRACT_MARKER: markerPath,
			...(addTrustResourceAtSessionStart ? { PI_CURSOR_CONTRACT_ADD_TRUST_RESOURCE_AT_SESSION_START: "1" } : {}),
			PI_CURSOR_NATIVE_TOOL_DISPLAY: "0",
			PI_CURSOR_PI_TOOL_BRIDGE: "0",
			PI_CURSOR_SETTING_SOURCES: "none",
		});
		const args = [
			piCli,
			...(trusted === undefined ? [] : [trusted ? "--approve" : "--no-approve"]),
			...(projectLocalPackage ? [] : ["-e", probeExtensionPath]),
			"--model",
			"cursor-sdk/composer-2-5",
			"--cursor-no-fast",
			"--no-tools",
			"--no-session",
			...(projectLocalPackage ? [] : ["--no-extensions"]),
			"--offline",
		];
		let input: string | undefined;
		if (mode === "rpc") {
			args.push("--mode", "rpc");
			input = `${JSON.stringify({ id: "contract-prompt", type: "prompt", message: "contract probe" })}\n`;
		} else {
			if (mode === "json") args.push("--mode", "json");
			args.push("-p", "contract probe");
		}
		const result = spawnSync(process.execPath, args, {
			cwd: projectDir,
			encoding: "utf8",
			env,
			input,
			timeout: 60_000,
			maxBuffer: 2 * 1024 * 1024,
		});
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(mode === "print" ? 1 : 0);
		const events = readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as MarkerEvent);
		return { output: `${result.stdout}\n${result.stderr}`, events };
	}

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores project cloud runtime under --no-approve in %s mode", (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		const { output, events } = runPi(mode, false);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: false });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
		expect(output).not.toContain("Cursor cloud runtime requires first-use acknowledgement");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("excludes project cloud acknowledgement in approved %s mode", (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		const { output, events } = runPi(mode, true);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("retains Pi project-trust event provenance in %s mode", (mode, hasUI) => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const { output, events } = runPi(mode);

		expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "project_trust" })]));
		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: false,
			acknowledgementSource: "builtin",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("honors explicit approval for standalone project config in %s mode", (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = runPi(mode, true);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "cloud",
			runtimeSource: "project",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores standalone project cloud runtime without a trust decision in %s mode", (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = runPi(mode);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
		expect(output).not.toContain("Cursor cloud runtime requires first-use acknowledgement");
	}, 90_000);

	it.each([
		["print", false],
		["json", false],
		["rpc", true],
	] as const)("ignores a trust resource added after Pi trust resolution in %s mode", (mode, hasUI) => {
		writeFileSync(join(agentDir, "cursor-sdk.json"), JSON.stringify({ cloud: { acknowledged: true } }));
		const { output, events } = runPi(mode, undefined, true);

		expect(events).toContainEqual({ event: "session_start", mode, hasUI, trusted: true });
		expect(events).toContainEqual({
			event: "provider_config",
			runtime: "local",
			runtimeSource: "builtin",
			acknowledged: true,
			acknowledgementSource: "user",
		});
		expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "ui_confirm" })]));
		expect(output).toContain("Cursor SDK runs require a Cursor SDK API key");
	}, 90_000);

	it.each([
		[undefined, "local", "builtin"],
		[true, "cloud", "project"],
	] as const)(
		"requires explicit --approve=%s for project-local package config",
		(trusted, runtime, runtimeSource) => {
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ packages: [packedPackageRoot] }),
			);
			new ProjectTrustStore(agentDir).set(projectDir, true);

			const { events } = runPi("print", trusted, false, true);

			expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ event: "project_trust" })]));
			expect(events).toContainEqual({ event: "session_start", mode: "print", hasUI: false, trusted: true });
			expect(events).toContainEqual(expect.objectContaining({
				event: "provider_config",
				runtime,
				runtimeSource,
			}));
		},
		90_000,
	);

	it("fails cloud preflight before SDK create or send when project acknowledgement is the only acknowledgement", async () => {
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}\n");
		cursorSessionScopeTestUtils.set(projectDir, join(runRoot, "session.jsonl"), "contract-session", true);
		const send = vi.fn();
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel("composer-2.5"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("Cursor cloud runtime requires first-use acknowledgement");
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
