import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_BUNDLE = readFileSync(join(REPO, "node_modules/@cursor/sdk/dist/bundled/index.js"), "utf8");
const GUARD_URL = pathToFileURL(join(REPO, "src/cursor-sdk-process-error-guard.ts")).href;

// The installed SDK's local shell tool path, as exact 1.0.32 source. A rename or a fix upstream
// fails these anchors, which is the signal to re-verify the containment contract.
const SHELL_EXEC_ANCHORS = {
	shellStreamUsesReplayCache: "register(QZ,Ml1(L))",
	replayCacheForExecId: "let G=$.execute(X,Y,Q),q=new mD0(G);Z.set(K,q),yield*q.fork()",
	unobservedPump: "constructor($){this.source=$;this.consume()}",
	readersClosedNormallyOnError: "finally{this.closed=!0;for(let $ of this.forks)$.close();this.forks.clear()}",
} as const;
const ZSH_EXECUTE_ANCHOR = 'async*execute($,J,Z){let v=[];try{const X=k0(v,R0($.withName("ZshState.execute"))';

/** Source of the minified declaration that starts at `anchor`, balanced on braces outside string literals. */
function sdkDeclaration(anchor: string): string {
	const start = SDK_BUNDLE.indexOf(anchor);
	if (start < 0) throw new Error(`installed @cursor/sdk no longer contains ${anchor}`);
	let depth = 0;
	let quote: string | undefined;
	for (let i = SDK_BUNDLE.indexOf("{", start); i < SDK_BUNDLE.length; i++) {
		const char = SDK_BUNDLE[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && --depth === 0) {
			return SDK_BUNDLE.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced declaration at ${anchor}`);
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SDK_FIXTURE_DIR = "node_modules/@cursor/sdk/dist/bundled";

// Each omp-host case blocks in spawnSync, so it needs a per-test timeout above Bun's 5s default.
// The margin lets spawnSync kill a hung child and report its output before the test times out.
const OMP_HOST_CHILD_TIMEOUT_MS = 30_000;
const OMP_HOST_TEST_TIMEOUT_MS = OMP_HOST_CHILD_TIMEOUT_MS + 10_000;

type OmpHostAction = "shell-spawn" | "write-after-close" | "read-missing-file";

interface OmpHostRun {
	status: number | null;
	output: string;
	log: string;
	missingCwdExists: boolean;
}

/**
 * Runs `action` in a Bun process that imports omp's real postmortem handlers (pi-utils) and the
 * guard module, beside a fixture built from the installed SDK's own writable iterable (`M5`) and
 * replay cache (`mD0`). `runShellStreamExec` wires a shell spawn into them like `ZshState.execute`;
 * `writeAfterClose` writes to a closed iterable; `readMissingFile` raises a real errno error from a
 * syscall other than spawn. A fixture under `node_modules/@cursor/sdk/dist/` carries SDK stack
 * provenance; one anywhere else does not.
 */
function runInOmpHost(options: { guardSetup: string; action: OmpHostAction; fixtureDir?: string }): OmpHostRun {
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-spawn-"));
	tempRoots.push(root);
	const fixturePath = join(root, options.fixtureDir ?? SDK_FIXTURE_DIR, "index.js");
	mkdirSync(dirname(fixturePath), { recursive: true });
	writeFileSync(
		fixturePath,
		`import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
${sdkDeclaration("class q9 extends Error")}
${sdkDeclaration("function M5(){")}
${sdkDeclaration("class mD0{")}
async function* execute(cwd) {
	let Q = M5();
	let D = spawn("/bin/sh", ["-c", "pwd"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	D.on("error", (f) => { Q.throw(f); });
	D.on("close", () => { Q.close(); });
	yield* Q;
}
export async function runShellStreamExec(cwd) {
	const events = [];
	for await (const event of new mD0(execute(cwd)).fork()) events.push(event);
	return events;
}
export function writeAfterClose() {
	const writable = M5();
	writable.close();
	void writable.write("late");
}
export async function readMissingFile(path) {
	readFileSync(path);
}
`,
	);
	const home = join(root, "home");
	mkdirSync(home);
	const missingCwd = join(root, "missing-cwd");
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") };
	delete env.XDG_STATE_HOME;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	const actions: Record<OmpHostAction, string> = {
		"shell-spawn": `console.log("tool stream events: " + JSON.stringify(await runShellStreamExec(${JSON.stringify(missingCwd)})));`,
		"write-after-close": "writeAfterClose();",
		"read-missing-file": `void readMissingFile(${JSON.stringify(join(root, "missing-file"))});`,
	};
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { getLogsDir, postmortem } from "@oh-my-pi/pi-utils";
import { installCursorSdkSessionProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
import { readMissingFile, runShellStreamExec, writeAfterClose } from ${JSON.stringify(pathToFileURL(fixturePath).href)};
// Referenced so Bun's import elision keeps the guard module loaded when the setup does not use it.
void installCursorSdkSessionProcessErrorGuard;
console.log("logs dir: " + getLogsDir());
// Registered before the guard, so it sees every rejection first and never claims one.
const rejectionReachedHost = Promise.withResolvers();
postmortem.interceptUnhandledRejections((reason) => {
	rejectionReachedHost.resolve(reason);
	return false;
});
${options.guardSetup}
${actions[options.action]}
const reason = await rejectionReachedHost.promise;
console.log("host handler saw: " + (reason.code ?? reason.name));
`,
		],
		{ cwd: REPO, env, encoding: "utf8", timeout: OMP_HOST_CHILD_TIMEOUT_MS },
	);
	const output = `${result.stdout}\n${result.stderr}`;
	const logsDir = output.match(/^logs dir: (.+)$/m)?.[1];
	if (logsDir && !logsDir.startsWith(home)) throw new Error(`omp logs escaped the test home: ${logsDir}`);
	const log =
		logsDir && existsSync(logsDir)
			? readdirSync(logsDir)
					.filter((name) => name.endsWith(".log"))
					.map((name) => readFileSync(join(logsDir, name), "utf8"))
					.join("\n")
			: "";
	return { status: result.status, output, log, missingCwdExists: existsSync(missingCwd) };
}

describe("Cursor SDK rejection containment in the omp host", () => {
	it("still reaches the local shell tool through the installed SDK's orphaning replay cache", () => {
		for (const [fact, anchor] of Object.entries(SHELL_EXEC_ANCHORS)) {
			expect(SDK_BUNDLE.split(anchor).length - 1, fact).toBe(1);
		}
		const zshExecute = sdkDeclaration(ZSH_EXECUTE_ANCHOR);
		expect(zshExecute).toContain("let K=Z?.workingDirectory??this.cwd;");
		expect(zshExecute).toContain("cwd:K,detached:!0}");
		expect(zshExecute).toContain('D.on("error",(f)=>{Q.throw(f)})');
		expect(zshExecute).not.toMatch(/existsSync|statSync|accessSync|mkdir/);
	});

	it("kills the omp host on a shell spawn with a missing working directory when no Cursor guard is active", () => {
		const run = runInOmpHost({ guardSetup: "", action: "shell-spawn" });

		expect(run.missingCwdExists).toBe(false);
		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, OMP_HOST_TEST_TIMEOUT_MS);

	it("keeps the omp host alive, ends the tool stream without an exit event, and logs the failed spawn", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "shell-spawn" });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("tool stream events: []");
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).not.toContain("[Unhandled Rejection]");
		expect(run.log).toContain("Cursor SDK shell failed to start");
		expect(run.log).toContain("ENOENT");
	}, OMP_HOST_TEST_TIMEOUT_MS);

	it("keeps a spawn failure without Cursor SDK stack provenance fatal while the guard is active", () => {
		const run = runInOmpHost({
			guardSetup: "installCursorSdkSessionProcessErrorGuard();",
			action: "shell-spawn",
			fixtureDir: "lib",
		});

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, OMP_HOST_TEST_TIMEOUT_MS);

	it("keeps a Cursor SDK errno failure from a syscall other than spawn fatal while the guard is active", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "read-missing-file" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
		expect(run.log).not.toContain("Cursor SDK shell failed to start");
	}, OMP_HOST_TEST_TIMEOUT_MS);

	it("stops containing once the Cursor session guard is disposed", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard().dispose();", action: "shell-spawn" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, OMP_HOST_TEST_TIMEOUT_MS);

	it("contains the SDK's closed-writable rejection through omp's host handler", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "write-after-close" });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: WriteIterableClosedError");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, OMP_HOST_TEST_TIMEOUT_MS);
});
