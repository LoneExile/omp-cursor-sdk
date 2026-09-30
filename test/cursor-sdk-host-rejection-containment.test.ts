import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeCursorCloudGitEnvironment } from "../src/cursor-cloud-local-state.js";
import { runGit } from "./helpers/git-repo.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_BUNDLE = readFileSync(join(REPO, "node_modules/@cursor/sdk/dist/bundled/index.js"), "utf8");
const GUARD_URL = pathToFileURL(join(REPO, "src/cursor-sdk-process-error-guard.ts")).href;

// The installed SDK's local shell tool path, as exact 1.0.34 source. A rename or a change upstream
// fails these anchors, which is the signal to re-verify that a shell that cannot start still reaches
// the model as an error. In 1.0.32 the replay cache dropped the stream error (`mD0` ended its
// readers normally), so the spawn failure escaped as an unhandled rejection; 1.0.34 forwards the
// error to every reader, so the guard has no shell case and a shell-shaped spawn rejection stays fatal.
const SHELL_EXEC_ANCHORS = {
	shellStreamUsesReplayCache: "register(MZ,yt1(U))",
	replayCacheForExecId: "let G=$.execute(X,Y,Q),q=new KT0(G);Z.set(K,q),yield*q.fork()",
	pumpStartsFromConstructor: "constructor($){this.source=$;this.consume()}",
	streamErrorKept: "catch($){this.error=$ instanceof Error?$:Error(String($))}",
	readersThrownTheError: "for(let $ of this.forks)if(this.error)$.throw(this.error);else $.close()",
	lateReadersReplayTheError: "for(let Q of X)yield Q;if(Y)throw Y",
	toolStreamErrorBecomesThrowFrame: 'await B.write(new C9({message:{case:"throw"',
} as const;
const ZSH_EXECUTE_ANCHOR = 'async*execute($,J,Z){let S=[];try{const X=E0(S,k0($.withName("ZshState.execute"))';

// The installed SDK's ripwalk (`rg --files`), as exact 1.0.34 source. `sy8` arms `processExit` with
// `child.on('error', reject)` when it spawns; `IE0`'s line generator awaits it only after stdout has
// ended and only when no line was read. A ripgrep that cannot start closes stdout first, so the
// rejection has no handler and the guard's ripgrep case is what keeps omp alive. If the SDK starts
// observing `processExit` at spawn (an early await or a catch), an anchor may fail, but the signal
// is the "no guard" host test: once omp no longer exits on the rejection, remove the guard's ripgrep case.
const RIPWALK_ANCHORS = {
	processExitArmedAtSpawn:
		'let K=new Promise((G,q)=>{Y.on("error",q),Y.on("close",(z)=>G(z??0))});if(!Y.stdout)throw Error("No stdout from ripgrep process");',
	processExitHandedToTheWalk: "return{stdout:Y.stdout,processExit:K,",
	stdoutIsDrainedFirst: "let S=await Promise.race([w.next(),U.aborted]);",
	processExitAwaitedAfterStdoutEnds: "if(A>0);else if(!O){let S=await U.processExit;if(S!==0&&S!==1){",
} as const;

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

// Each case blocks in spawnSync, so it needs a per-test timeout above Bun's 5s default.
// The margin lets spawnSync kill a hung child and report its output before the test times out.
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;

/**
 * A fixture module built from the installed SDK's own writable iterable (`v5`), closed-writable
 * error class (`f7`) and exec replay cache (`KT0`). `runShellStreamExec` wires a shell spawn into
 * them like `ZshState.execute`; `writeAfterClose` writes to a closed iterable; `readMissingFile`
 * raises a real errno error from a syscall; `rejectWithAbort` and `rejectWithConnectUnavailable`
 * reject with a real `AbortController` reason and a real `@connectrpc/connect` `ConnectError`;
 * `rejectWithSpawnFailure` leaves the asynchronous spawn error of a file that cannot start
 * unobserved, the way the SDK's ripwalk stream does. A fixture under `node_modules/@cursor/sdk/dist/`
 * carries SDK stack provenance; one anywhere else does not.
 */
function writeSdkFixture(fixtureDir: string): { root: string; fixturePath: string } {
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-host-"));
	tempRoots.push(root);
	const fixturePath = join(root, fixtureDir, "index.js");
	mkdirSync(dirname(fixturePath), { recursive: true });
	writeFileSync(
		fixturePath,
		`import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Code, ConnectError } from ${JSON.stringify(pathToFileURL(join(REPO, "node_modules/@connectrpc/connect/dist/esm/index.js")).href)};
${sdkDeclaration("class f7 extends Error")}
${sdkDeclaration("function v5(){")}
${sdkDeclaration("class KT0{")}
async function* execute(cwd) {
	let Q = v5();
	let D = spawn("/bin/sh", ["-c", "pwd"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	D.on("error", (b) => { Q.throw(b); });
	D.on("close", () => { Q.close(); });
	yield* Q;
}
export async function runShellStreamExec(cwd) {
	const events = [];
	for await (const event of new KT0(execute(cwd)).fork()) events.push(event);
	return events;
}
export function writeAfterClose() {
	const writable = v5();
	writable.close();
	void writable.write("late");
}
export async function readMissingFile(path) {
	readFileSync(path);
}
export function rejectWithAbort() {
	const controller = new AbortController();
	controller.abort();
	void Promise.reject(controller.signal.reason);
}
export function rejectWithConnectUnavailable() {
	void Promise.reject(new ConnectError("backend unavailable", Code.Unavailable));
}
export function rejectWithSpawnFailure(file) {
	void new Promise((_, reject) => {
		spawn(file, ["--files"], { stdio: "ignore" }).on("error", reject);
	});
}
`,
	);
	return { root, fixturePath };
}

/** A Bun child that isolates omp's state and logs under a throwaway home. */
function childEnv(root: string): Record<string, string | undefined> {
	const home = join(root, "home");
	mkdirSync(home);
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, "agent") };
	delete env.XDG_STATE_HOME;
	delete env.PI_CONFIG_DIR;
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	return env;
}

interface ChildRun {
	status: number | null;
	output: string;
}

interface HostRun extends ChildRun {
	/** What omp's logger wrote under the child's throwaway home. */
	log: string;
}

/** Reads the omp log files of a child that printed its `logs dir:`, refusing a dir outside its home. */
function readOmpLog(output: string, root: string): string {
	const logsDir = output.match(/^logs dir: (.+)$/m)?.[1];
	if (!logsDir) return "";
	if (!logsDir.startsWith(join(root, "home"))) throw new Error(`omp logs escaped the test home: ${logsDir}`);
	if (!existsSync(logsDir)) return "";
	return readdirSync(logsDir)
		.filter((name) => name.endsWith(".log"))
		.map((name) => readFileSync(join(logsDir, name), "utf8"))
		.join("\n");
}

/**
 * Runs the fixture's shell spawn with a missing working directory through the SDK's own replay
 * cache in a Bun child that has no Cursor guard and only records what reaches the reader and the
 * process-level rejection listener.
 */
function runShellSpawnWithMissingCwd(): ChildRun & { missingCwdExists: boolean } {
	const { root, fixturePath } = writeSdkFixture(SDK_FIXTURE_DIR);
	const missingCwd = join(root, "missing-cwd");
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { runShellStreamExec } from ${JSON.stringify(pathToFileURL(fixturePath).href)};
process.on("unhandledRejection", (reason) => console.log("rejection escaped: " + (reason.code ?? reason.name)));
try {
	const events = await runShellStreamExec(${JSON.stringify(missingCwd)});
	console.log("reader finished without an error after " + events.length + " events");
} catch (error) {
	console.log("reader error: " + error.code);
}
// An orphaned rejection is reported once the microtask queue drains, so a few macrotask turns observe it.
for (let turn = 0; turn < 3; turn++) {
	const { promise, resolve } = Promise.withResolvers();
	setImmediate(resolve);
	await promise;
}
`,
		],
		{ cwd: REPO, env: childEnv(root), encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	return { status: result.status, output: `${result.stdout}\n${result.stderr}`, missingCwdExists: existsSync(missingCwd) };
}

type OmpHostAction =
	| "write-after-close"
	| "read-missing-file"
	| "abort-rejection"
	| "connect-unavailable"
	| "spawn-failure-ripgrep"
	| "spawn-failure-shell";

/**
 * Runs `action` in a Bun process that imports omp's real postmortem handlers (pi-utils) and the
 * guard module, beside the fixture module. `guardSetup` runs before the action; a host handler
 * registered ahead of it sees every rejection first and never claims one.
 */
function runInOmpHost(options: { guardSetup: string; action: OmpHostAction; fixtureDir?: string }): HostRun {
	const { root, fixturePath } = writeSdkFixture(options.fixtureDir ?? SDK_FIXTURE_DIR);
	const actions: Record<OmpHostAction, string> = {
		"write-after-close": "writeAfterClose();",
		"read-missing-file": `void readMissingFile(${JSON.stringify(join(root, "missing-file"))});`,
		"abort-rejection": "rejectWithAbort();",
		"connect-unavailable": "rejectWithConnectUnavailable();",
		"spawn-failure-ripgrep": `rejectWithSpawnFailure(${JSON.stringify(join(root, "missing-bin", "rg"))});`,
		"spawn-failure-shell": `rejectWithSpawnFailure(${JSON.stringify(join(root, "missing-bin", "zsh"))});`,
	};
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { getLogsDir, postmortem } from "@oh-my-pi/pi-utils";
import { installCursorSdkProcessErrorGuard, installCursorSdkSessionProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
import { readMissingFile, rejectWithAbort, rejectWithConnectUnavailable, rejectWithSpawnFailure, writeAfterClose } from ${JSON.stringify(pathToFileURL(fixturePath).href)};
// Referenced so Bun's import elision keeps the guard module loaded when the setup does not use it.
void installCursorSdkProcessErrorGuard;
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
console.log("host handler saw: " + (typeof reason.code === "string" ? reason.code : reason.name));
`,
		],
		{ cwd: REPO, env: childEnv(root), encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	const output = `${result.stdout}\n${result.stderr}`;
	return { status: result.status, output, log: readOmpLog(output, root) };
}

/**
 * Drives the installed SDK's own startup walk in a Bun process that imports omp's real postmortem
 * handlers and the guard module: a local agent in a git workspace whose CURSOR_RIPGREP_PATH names a
 * binary that does not exist. The child runs with no API key (the script deletes it after Bun has
 * loaded any `.env` from the repo), so `Agent.create` builds the local runtime without the keyed
 * bootstrap, and its first `send` starts the workspace walk (ignore files, rules, skills and nested
 * AGENTS.md) that spawns ripgrep. The proxy variables point at a closed port as a
 * precaution; the SDK's own transport may not honor them and the test does not depend on them.
 */
function runRipgrepStartupWalk(guardSetup: string): HostRun & { missingRipgrep: string } {
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-rg-walk-"));
	tempRoots.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	runGit(workspace, ["init", "-q"]);
	const missingRipgrep = join(root, "missing-bin", "rg");
	// GIT_DIR and friends from the test process would make the SDK's own git calls, and a workspace `git init`, hit another repository.
	const env = sanitizeCursorCloudGitEnvironment(childEnv(root));
	env.CURSOR_RIPGREP_PATH = missingRipgrep;
	delete env.CURSOR_API_KEY;
	env.HTTPS_PROXY = "http://127.0.0.1:9";
	env.HTTP_PROXY = "http://127.0.0.1:9";
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { getLogsDir, postmortem } from "@oh-my-pi/pi-utils";
import { Agent } from "@cursor/sdk";
import { installCursorSdkProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
// Referenced so Bun's import elision keeps the guard module loaded when the setup does not use it.
void installCursorSdkProcessErrorGuard;
console.log("logs dir: " + getLogsDir());
// Registered before the guard, so it sees every rejection first and never claims one.
const rejectionReachedHost = Promise.withResolvers();
postmortem.interceptUnhandledRejections((reason) => {
	rejectionReachedHost.resolve(reason);
	return false;
});
${guardSetup}
// Bun and omp load a \`.env\` from the working directory at startup; a maintainer's key must not reach the SDK.
delete process.env.CURSOR_API_KEY;
const agent = await Agent.create({ model: { id: "composer-2-5" }, local: { cwd: ${JSON.stringify(workspace)}, settingSources: ["project"] } });
void agent.send("walk the workspace").catch(() => undefined);
const reason = await Promise.race([
	rejectionReachedHost.promise,
	new Promise((resolve) => setTimeout(() => resolve({ code: "none", syscall: "no rejection within 20s" }), 20_000)),
]);
// The walk's remaining rejections arrive within a few macrotask turns of the first.
await new Promise((resolve) => setTimeout(resolve, 500));
console.log("host handler saw: " + reason.code + " " + reason.syscall);
process.exit(0);
`,
		],
		{ cwd: REPO, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	const output = `${result.stdout}\n${result.stderr}`;
	return { status: result.status, output, log: readOmpLog(output, root), missingRipgrep };
}

describe("Cursor SDK shell spawn failures", () => {
	it("still forwards the shell tool's stream error to its readers through the installed SDK's replay cache", () => {
		for (const [fact, anchor] of Object.entries(SHELL_EXEC_ANCHORS)) {
			expect(SDK_BUNDLE.split(anchor).length - 1, fact).toBe(1);
		}
		const zshExecute = sdkDeclaration(ZSH_EXECUTE_ANCHOR);
		expect(zshExecute).toContain("let K=Z?.workingDirectory??this.cwd;");
		expect(zshExecute).toContain("cwd:K,detached:!0}");
		expect(zshExecute).toContain('D.on("error",(b)=>{Q.throw(b)})');
		expect(zshExecute).not.toMatch(/existsSync|statSync|accessSync|mkdir/);
	});

	it("reaches the reader as the spawn error and orphans no rejection", () => {
		const run = runShellSpawnWithMissingCwd();

		expect(run.missingCwdExists).toBe(false);
		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("reader error: ENOENT");
		expect(run.output).not.toContain("rejection escaped");
		expect(run.output).not.toContain("reader finished without an error");
	}, TEST_TIMEOUT_MS);
});

describe("Cursor SDK ripgrep spawn failures", () => {
	it("still leaves the ripwalk stream's processExit promise unobserved until its stdout has ended", () => {
		for (const [fact, anchor] of Object.entries(RIPWALK_ANCHORS)) {
			expect(SDK_BUNDLE.split(anchor).length - 1, fact).toBe(1);
		}
	});

	it("kills the omp host on the installed SDK's startup walk when ripgrep cannot start and no Cursor guard is active", () => {
		const run = runRipgrepStartupWalk("");

		expect(run.status, run.output).toBe(1);
		expect(run.output).toContain("[Unhandled Rejection]");
		expect(run.output).toContain(`ENOENT: no such file or directory, posix_spawn '${run.missingRipgrep}'`);
	}, TEST_TIMEOUT_MS);

	it("contains the installed SDK's startup-walk rejection when ripgrep cannot start, through omp's host handler", () => {
		const run = runRipgrepStartupWalk("installCursorSdkProcessErrorGuard();");

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain(`host handler saw: ENOENT spawn ${run.missingRipgrep}`);
		expect(run.output).not.toContain("[Unhandled Rejection]");
		expect(run.log).toContain("Cursor's ripgrep failed to start");
		expect(run.log).toContain(run.missingRipgrep);
		expect(run.log).toContain("CURSOR_RIPGREP_PATH");
	}, TEST_TIMEOUT_MS);
});

describe("Cursor SDK rejection containment in the omp host", () => {
	it("kills the omp host on the SDK's closed-writable rejection when no Cursor guard is active", () => {
		const run = runInOmpHost({ guardSetup: "", action: "write-after-close" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: WriteIterableClosedError");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("contains the SDK's closed-writable rejection through omp's host handler", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "write-after-close" });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: WriteIterableClosedError");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps a closed-writable rejection without Cursor SDK stack provenance fatal while the guard is active", () => {
		const run = runInOmpHost({
			guardSetup: "installCursorSdkSessionProcessErrorGuard();",
			action: "write-after-close",
			fixtureDir: "lib",
		});

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: WriteIterableClosedError");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps an unrecognized Cursor SDK rejection fatal while the guard is active", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "read-missing-file" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("contains a raw Cursor SDK AbortError rejection through omp's host handler", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "abort-rejection" });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: AbortError");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps an AbortError rejection without Cursor SDK stack provenance fatal while the guard is active", () => {
		const run = runInOmpHost({
			guardSetup: "installCursorSdkSessionProcessErrorGuard();",
			action: "abort-rejection",
			fixtureDir: "lib",
		});

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: AbortError");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("contains a Cursor SDK network ConnectError rejection while a provider turn is active", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkProcessErrorGuard();", action: "connect-unavailable" });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: ConnectError");
		expect(run.output).not.toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps a Cursor SDK network ConnectError rejection fatal when only the session guard is active", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard();", action: "connect-unavailable" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ConnectError");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps a network ConnectError rejection without Cursor SDK stack provenance fatal during a provider turn", () => {
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "connect-unavailable",
			fixtureDir: "lib",
		});

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ConnectError");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("stops containing once the Cursor session guard is disposed", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkSessionProcessErrorGuard().dispose();", action: "write-after-close" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: WriteIterableClosedError");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps an SDK shell-shaped spawn rejection fatal while the guard is active", () => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkProcessErrorGuard();", action: "spawn-failure-shell" });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);

	it("keeps a ripgrep spawn rejection without Cursor SDK stack provenance fatal while the guard is active", () => {
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "spawn-failure-ripgrep",
			fixtureDir: "lib",
		});

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);
});
