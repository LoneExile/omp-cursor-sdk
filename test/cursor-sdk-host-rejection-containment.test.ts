import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Whether a directory with mode 000 blocks entry here. It does not for root, a process with
// CAP_DAC_OVERRIDE, or a filesystem that ignores mode bits; there the spawn from that directory
// succeeds and the EACCES test has nothing to observe.
const MODE_000_BLOCKS_ENTRY = (() => {
	if (process.platform === "win32") return false;
	const dir = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-mode000-"));
	try {
		chmodSync(dir, 0o000);
		try {
			accessSync(dir, constants.X_OK);
			return false;
		} catch {
			return true;
		}
	} finally {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
})();

// The errnos that mean the system could not start a file for lack of a resource, with libuv's message for each.
const RESOURCE_ERRNO_FIXTURES: Record<string, string> = {
	EAGAIN: "resource temporarily unavailable",
	EMFILE: "too many open files",
	ENFILE: "file table overflow",
};

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
export function rejectWithSpawnFailure(file, cwd) {
	void new Promise((_, reject) => {
		spawn(file, ["--files"], { stdio: "ignore", cwd }).on("error", reject);
	});
}
// A spawn error with the message, code, syscall (\`spawn <file>\`) and path that Bun reports, for an errno
// a test cannot provoke portably (a real EAGAIN needs a process limit set on the child, and what
// ulimit -u counts differs by platform).
export function rejectWithSpawnErrno(code, reason, file) {
	void Promise.reject(Object.assign(new Error(code + ": " + reason + ", posix_spawn '" + file + "'"), { code, syscall: "spawn " + file, path: file }));
}
// A spawn-shaped error with no errno code, which no observed failure looks like.
export function rejectWithSpawnErrorWithoutCode(file) {
	void Promise.reject(Object.assign(new Error("spawn failed, posix_spawn '" + file + "'"), { syscall: "spawn " + file, path: file }));
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
	delete env.CURSOR_RIPGREP_PATH;
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
	| "spawn-failure-configured-ripgrep"
	| "spawn-failure-configured-ripgrep-missing-cwd"
	| "spawn-failure-configured-ripgrep-inaccessible-cwd"
	| "spawn-failure-without-errno-code"
	| "spawn-failure-resource-limit"
	| "spawn-failure-shell";

/** Runs `run` with `dir` created empty and unenterable (mode 000), then restores access so the root can be removed. */
function withUnenterableDir<T>(dir: string | undefined, run: () => T): T {
	if (dir === undefined) return run();
	mkdirSync(dir);
	chmodSync(dir, 0o000);
	try {
		return run();
	} finally {
		chmodSync(dir, 0o700);
	}
}

/**
 * Runs `action` in a Bun process that imports omp's real postmortem handlers (pi-utils) and the
 * guard module, beside the fixture module. `guardSetup` runs before the action; a host handler
 * registered ahead of it sees every rejection first and never claims one.
 */
function runInOmpHost(options: { guardSetup: string; action: OmpHostAction; fixtureDir?: string; env?: Record<string, string>; noAccessDir?: boolean }): HostRun {
	const { root, fixturePath } = writeSdkFixture(options.fixtureDir ?? SDK_FIXTURE_DIR);
	const actions: Record<OmpHostAction, string> = {
		"write-after-close": "writeAfterClose();",
		"read-missing-file": `void readMissingFile(${JSON.stringify(join(root, "missing-file"))});`,
		"abort-rejection": "rejectWithAbort();",
		"connect-unavailable": "rejectWithConnectUnavailable();",
		// The SDK's resolver accepts the file `rg` (`rg.exe` on Windows) found another way than CURSOR_RIPGREP_PATH.
		"spawn-failure-ripgrep": `rejectWithSpawnFailure(${JSON.stringify(join(root, "missing-bin", process.platform === "win32" ? "rg.exe" : "rg"))});`,
		// Spawns the file CURSOR_RIPGREP_PATH names, which the test makes fail to start.
		"spawn-failure-configured-ripgrep": "rejectWithSpawnFailure(process.env.CURSOR_RIPGREP_PATH);",
		// Spawns that file from a working directory that does not exist, so a file that exists fails with ENOENT.
		"spawn-failure-configured-ripgrep-missing-cwd": `rejectWithSpawnFailure(process.env.CURSOR_RIPGREP_PATH, ${JSON.stringify(join(root, "missing-cwd"))});`,
		// Spawns that file from a working directory the process cannot enter (`noAccessDir`), so a file that is executable fails with EACCES.
		"spawn-failure-configured-ripgrep-inaccessible-cwd": `rejectWithSpawnFailure(process.env.CURSOR_RIPGREP_PATH, ${JSON.stringify(join(root, "no-access"))});`,
		// Looks like a spawn failure of ripgrep, but has no errno code.
		"spawn-failure-without-errno-code": "rejectWithSpawnErrorWithoutCode(process.env.CURSOR_RIPGREP_PATH);",
		// The file exists and runs; the system refused to start it for lack of a resource (the errno and message come from the env).
		"spawn-failure-resource-limit": "rejectWithSpawnErrno(process.env.SPAWN_ERRNO_CODE, process.env.SPAWN_ERRNO_REASON, process.env.CURSOR_RIPGREP_PATH);",
		"spawn-failure-shell": `rejectWithSpawnFailure(${JSON.stringify(join(root, "missing-bin", "zsh"))});`,
	};
	const result = withUnenterableDir(options.noAccessDir ? join(root, "no-access") : undefined, () =>
		spawnSync(
			process.execPath,
			[
				"--eval",
				`import { getLogsDir, postmortem } from "@oh-my-pi/pi-utils";
import { installCursorSdkProcessErrorGuard, installCursorSdkSessionProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
import { readMissingFile, rejectWithAbort, rejectWithConnectUnavailable, rejectWithSpawnErrno, rejectWithSpawnErrorWithoutCode, rejectWithSpawnFailure, writeAfterClose } from ${JSON.stringify(pathToFileURL(fixturePath).href)};
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
			{ cwd: REPO, env: { ...childEnv(root), ...options.env }, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
		),
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
 * AGENTS.md) that spawns ripgrep. After `send` the SDK also POSTs `auth/exchange_user_api_key` to
 * Cursor's backend through `fetch`, which Bun routes through the proxy variables: lowercase ones win
 * over uppercase ones, and a NO_PROXY that names the host skips the proxy. The child gets every
 * spelling pointed at a closed port and a NO_PROXY that names only `localhost`. Both are set rather
 * than deleted because the repo's `.env`, which Bun loads for any key that is unset and pi-utils for
 * any key that is unset or empty, could otherwise supply a NO_PROXY of its own. So the request cannot
 * leave the machine, and the walk does not wait on it.
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
	for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) env[name] = "http://127.0.0.1:9";
	env.NO_PROXY = "localhost";
	env.no_proxy = "localhost";
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
		// CURSOR_RIPGREP_PATH names the failing file, so the hint tells the user to fix or unset it.
		expect(run.log).toContain(
			"CURSOR_RIPGREP_PATH overrides the ripgrep Cursor runs and names this file. Fix it, or unset it to use the SDK's bundled ripgrep, then restart omp.",
		);
		expect(run.log).not.toContain("not a CURSOR_RIPGREP_PATH override");
	}, TEST_TIMEOUT_MS);

	it("does not blame CURSOR_RIPGREP_PATH when a ripgrep found another way cannot start", () => {
		// CURSOR_RIPGREP_PATH is unset, so the SDK's resolver fell back to the platform package or PATH.
		const run = runInOmpHost({ guardSetup: "installCursorSdkProcessErrorGuard();", action: "spawn-failure-ripgrep" });

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).not.toContain("[Unhandled Rejection]");
		expect(run.log).toContain("Cursor's ripgrep failed to start");
		expect(run.log).toContain("not a CURSOR_RIPGREP_PATH override");
		expect(run.log).not.toContain("overrides the ripgrep Cursor runs");
	}, TEST_TIMEOUT_MS);

	/** A platform-package `bin/rg` path under a throwaway root, as `ensureCursorRipgrepPath` would write it. */
	function bundledRipgrepPathUnderTempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-bundled-rg-"));
		tempRoots.push(root);
		const binary = process.platform === "win32" ? "rg.exe" : "rg";
		return join(root, "node_modules", "@cursor", `sdk-${process.platform}-${process.arch}`, "bin", binary);
	}

	it("does not tell the user to unset CURSOR_RIPGREP_PATH when it names a bundled ripgrep that is not executable", () => {
		// ensureCursorRipgrepPath wrote this platform-package path into the variable itself, so it is not a user override to unset: the fix is to restore that binary.
		const bundled = bundledRipgrepPathUnderTempRoot();
		mkdirSync(dirname(bundled), { recursive: true });
		writeFileSync(bundled, "not a binary", { mode: 0o644 });
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "spawn-failure-configured-ripgrep",
			env: { CURSOR_RIPGREP_PATH: bundled },
		});

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: EACCES");
		expect(run.log).toContain(`Cursor's ripgrep failed to start (${bundled})`);
		expect(run.log).toContain("not a CURSOR_RIPGREP_PATH override");
		expect(run.log).not.toContain("overrides the ripgrep Cursor runs");
	}, TEST_TIMEOUT_MS);

	it("does not tell the user to unset CURSOR_RIPGREP_PATH when it names a bundled ripgrep that is gone", () => {
		const bundled = bundledRipgrepPathUnderTempRoot();
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "spawn-failure-configured-ripgrep",
			env: { CURSOR_RIPGREP_PATH: bundled },
		});

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.log).toContain(`Cursor's ripgrep failed to start (${bundled})`);
		expect(run.log).toContain("not a CURSOR_RIPGREP_PATH override");
		expect(run.log).not.toContain("overrides the ripgrep Cursor runs");
	}, TEST_TIMEOUT_MS);

	it("points at the working directory, not the binary, when a ripgrep that exists fails with ENOENT", () => {
		// Bun reports a missing working directory as ENOENT on the spawned binary; process.execPath exists.
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "spawn-failure-configured-ripgrep-missing-cwd",
			env: { CURSOR_RIPGREP_PATH: process.execPath },
		});

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.log).toContain(`Cursor's ripgrep failed to start (${process.execPath})`);
		expect(run.log).toContain("exists, so the ENOENT is not about the binary itself");
		expect(run.log).not.toContain("overrides the ripgrep Cursor runs");
		expect(run.log).not.toContain("not a CURSOR_RIPGREP_PATH override");
	}, TEST_TIMEOUT_MS);

	it.skipIf(!MODE_000_BLOCKS_ENTRY)(
		"points at the working directory, not the binary, when a ripgrep that is executable fails with EACCES",
		() => {
			// Bun reports a working directory the process cannot enter as EACCES on the spawned binary; process.execPath is executable.
			const run = runInOmpHost({
				guardSetup: "installCursorSdkProcessErrorGuard();",
				action: "spawn-failure-configured-ripgrep-inaccessible-cwd",
				env: { CURSOR_RIPGREP_PATH: process.execPath },
				noAccessDir: true,
			});

			expect(run.status, run.output).toBe(0);
			expect(run.output).toContain("host handler saw: EACCES");
			expect(run.log).toContain(`Cursor's ripgrep failed to start (${process.execPath})`);
			expect(run.log).toContain("is an executable file, so the EACCES is not about the binary itself");
			expect(run.log).not.toContain("overrides the ripgrep Cursor runs");
			expect(run.log).not.toContain("not a CURSOR_RIPGREP_PATH override");
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")("keeps the override advice when CURSOR_RIPGREP_PATH names a directory", () => {
		// Spawning a directory fails with EACCES, as a file that is not executable does, but a directory is not an executable file.
		const dir = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-rg-dir-"));
		tempRoots.push(dir);
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "spawn-failure-configured-ripgrep",
			env: { CURSOR_RIPGREP_PATH: dir },
		});

		expect(run.status, run.output).toBe(0);
		expect(run.output).toContain("host handler saw: EACCES");
		expect(run.log).toContain(`Cursor's ripgrep failed to start (${dir})`);
		expect(run.log).toContain("CURSOR_RIPGREP_PATH overrides the ripgrep Cursor runs");
		expect(run.log).not.toContain("is an executable file");
	}, TEST_TIMEOUT_MS);

	// The file exists and runs; a process or open-file limit says nothing about the ripgrep.
	for (const [code, reason] of Object.entries(RESOURCE_ERRNO_FIXTURES)) {
		it(`does not blame the binary when the system could not start it for lack of a resource (${code})`, () => {
			const run = runInOmpHost({
				guardSetup: "installCursorSdkProcessErrorGuard();",
				action: "spawn-failure-resource-limit",
				env: { CURSOR_RIPGREP_PATH: process.execPath, SPAWN_ERRNO_CODE: code, SPAWN_ERRNO_REASON: reason },
			});

			expect(run.status, run.output).toBe(0);
			expect(run.output).toContain(`host handler saw: ${code}`);
			expect(run.log).toContain(`Cursor's ripgrep failed to start (${process.execPath})`);
			expect(run.log).toContain("a process or open-file limit, not a problem with the binary");
			expect(run.log).not.toContain("overrides the ripgrep Cursor runs");
			expect(run.log).not.toContain("not a CURSOR_RIPGREP_PATH override");
		}, TEST_TIMEOUT_MS);
	}
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

	it("keeps a spawn-shaped rejection from Cursor's SDK without an errno code fatal while the guard is active", () => {
		const run = runInOmpHost({
			guardSetup: "installCursorSdkProcessErrorGuard();",
			action: "spawn-failure-without-errno-code",
			env: { CURSOR_RIPGREP_PATH: process.execPath },
		});

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: Error");
		expect(run.output).toContain("[Unhandled Rejection]");
		expect(run.log).not.toContain("Cursor's ripgrep failed to start");
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
