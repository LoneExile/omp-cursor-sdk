import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeCursorCloudGitEnvironment } from "../src/cursor-cloud-local-state.js";
import { CURSOR_SDK_BUILDS, readCursorSdkBuildFiles, readCursorSdkBuildSource, readCursorSdkEntrySource } from "./helpers/cursor-sdk-build-source.js";
import { balancedDeclaration, escapeRegExp, IDENT, onlyMatch } from "./helpers/cursor-sdk-minified-source.js";
import { runGit } from "./helpers/git-repo.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_BUNDLE = readCursorSdkEntrySource("bundled");
const GUARD_URL = pathToFileURL(join(REPO, "src/cursor-sdk-process-error-guard.ts")).href;

// The guard has no spawn case: on the installed SDK a spawn error never leaves an unhandled rejection
// (the local shell forwards it to the model, every ripgrep spawn handles it). Everything below pins the
// SDK facts that rests on, in source that a rebuild which only renames minified identifiers does not
// break, and runs the SDK's own code where a run is possible. An anchor failing is the signal to
// re-measure, not to loosen the pattern. The "no guard" startup-walk test is the end-to-end sentinel:
// when omp dies on a ripgrep that cannot start, the guard needs its ripgrep case back.

const declarationAt = (start: number): string => balancedDeclaration(SDK_BUNDLE, start);

interface SdkExecShape {
	/** The SDK's closed-writable error class, its writable iterable factory and its exec replay cache class, as declared. */
	closedErrorClass: string;
	writableFactory: string;
	replayCacheClass: string;
	declarations: string;
	/** The replay cache class's own declaration, for pinning how it treats a failed source. */
	replayCacheDeclaration: string;
}

let execShape: SdkExecShape | undefined;

/** Finds, in the installed bundled build, the declarations the host-containment fixture is built from. */
function sdkExecShape(): SdkExecShape {
	if (execShape) return execShape;
	const closed = onlyMatch(
		SDK_BUNDLE,
		`class (${IDENT}) extends Error\\{constructor\\((${IDENT})\\)\\{super\\(\\2\\);this\\.name="WriteIterableClosedError"\\}\\}`,
		"the closed-writable error class",
	);
	const closedErrorClass = closed[1]!;
	const closedDeclaration = declarationAt(closed.index!);

	// The writable iterable factory is the zero-argument function that raises the closed-writable error.
	const factories = [...SDK_BUNDLE.matchAll(new RegExp(`function (${IDENT})\\(\\)\\{let ${IDENT}=\\[\\],${IDENT}=\\[\\],`, "g"))]
		.map((match) => ({ name: match[1]!, declaration: declarationAt(match.index!) }))
		.filter(({ declaration }) => declaration.includes(`new ${closedErrorClass}("WritableIterable is closed")`));
	expect(factories.map(({ name }) => name), "exactly one writable iterable factory raises WriteIterableClosedError").toHaveLength(1);
	const factory = factories[0]!;

	const replay = onlyMatch(
		SDK_BUNDLE,
		`class (${IDENT})\\{pastElements=\\[\\];closed=!1;error;forks=new Set;constructor\\((${IDENT})\\)\\{this\\.consume\\(\\2\\)\\}`,
		"the exec replay cache class",
	);
	const replayCacheDeclaration = declarationAt(replay.index!);

	execShape = {
		closedErrorClass,
		writableFactory: factory.name,
		replayCacheClass: replay[1]!,
		declarations: [closedDeclaration, factory.declaration, replayCacheDeclaration].join("\n"),
		replayCacheDeclaration,
	};
	return execShape;
}

/** The bundled build's syntax tree, parsed once: the SDK's single-letter names are only meaningful within their function. */
let sdkBundleAst: ts.SourceFile | undefined;

/** Text of the innermost function (declaration, expression, arrow or method) of the bundled build that contains `index`. */
function enclosingFunctionText(index: number): string {
	sdkBundleAst ??= ts.createSourceFile("cursor-sdk-bundled.js", SDK_BUNDLE, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
	const file = sdkBundleAst;
	const functions: ts.Node[] = [];
	const visit = (node: ts.Node): void => {
		if (index < node.getStart(file) || index >= node.end) return;
		if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) functions.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const enclosing = functions.at(-1);
	if (!enclosing) throw new Error(`no function of the installed SDK encloses offset ${index}`);
	return SDK_BUNDLE.slice(enclosing.getStart(file), enclosing.end);
}

/**
 * The ripwalk (`rg --files`) spawns ripgrep, arms `processExit` with the child's 'error' event and, since
 * 1.0.37, attaches a rejection handler to it right there. The walk awaits it only after stdout has ended
 * and only when no line was read, and a ripgrep that cannot start closes stdout first. The shape differs
 * by build (`let`/`const`, `()=>{return}`/`(()=>{})`, an extra parenthesis around the executor); the facts do not.
 */
const PROCESS_EXIT_OBSERVED_AT_SPAWN = new RegExp(
	`(?:let |const )(${IDENT})=new Promise\\(\\(?\\(?(${IDENT}),(${IDENT})\\)?=>\\{(${IDENT})\\.on\\("error",\\3\\),\\4\\.on\\("close",[^]{0,40}?\\)\\}\\)\\)?;` +
		`if\\(\\1\\.catch\\(\\(?\\(\\)=>\\{(?:return)?\\}\\)?\\),!\\4\\.stdout\\)throw (?:new )?Error\\("No stdout from ripgrep process"\\)`,
);

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
 * A fixture module built from the installed SDK's own writable iterable, closed-writable error class
 * and exec replay cache, each declaration cut out of the bundled build. `runShellStreamExec` wires a
 * shell spawn into them like `ZshState.execute`; `writeAfterClose` writes to a closed iterable;
 * `readMissingFile` raises a real errno error from a syscall; `rejectWithAbort` and
 * `rejectWithConnectUnavailable` reject with a real `AbortController` reason and a real
 * `@connectrpc/connect` `ConnectError`; `rejectWithSpawnFailure` leaves the asynchronous spawn error of
 * a file that cannot start unobserved. A fixture under `node_modules/@cursor/sdk/dist/` carries SDK
 * stack provenance; one anywhere else does not.
 */
function writeSdkFixture(fixtureDir: string): { root: string; fixturePath: string } {
	const shape = sdkExecShape();
	const root = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-host-"));
	tempRoots.push(root);
	const fixturePath = join(root, fixtureDir, "index.js");
	mkdirSync(dirname(fixturePath), { recursive: true });
	writeFileSync(
		fixturePath,
		`import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Code, ConnectError } from ${JSON.stringify(pathToFileURL(join(REPO, "node_modules/@connectrpc/connect/dist/esm/index.js")).href)};
${shape.declarations}
async function* execute(cwd) {
	let Q = ${shape.writableFactory}();
	let D = spawn("/bin/sh", ["-c", "pwd"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	D.on("error", (b) => { Q.throw(b); });
	D.on("close", () => { Q.close(); });
	yield* Q;
}
export async function runShellStreamExec(cwd) {
	const events = [];
	for await (const event of new ${shape.replayCacheClass}(execute(cwd)).fork()) events.push(event);
	return events;
}
export function writeAfterClose() {
	const writable = ${shape.writableFactory}();
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
	delete env.CURSOR_RIPGREP_PATH;
	return env;
}

interface ChildRun {
	status: number | null;
	output: string;
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
for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
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
function runInOmpHost(options: { guardSetup: string; action: OmpHostAction; fixtureDir?: string }): ChildRun {
	const { root, fixturePath } = writeSdkFixture(options.fixtureDir ?? SDK_FIXTURE_DIR);
	const actions: Record<OmpHostAction, string> = {
		"write-after-close": "writeAfterClose();",
		"read-missing-file": `void readMissingFile(${JSON.stringify(join(root, "missing-file"))});`,
		"abort-rejection": "rejectWithAbort();",
		"connect-unavailable": "rejectWithConnectUnavailable();",
		"spawn-failure-ripgrep": `rejectWithSpawnFailure(${JSON.stringify(join(root, "missing-bin", process.platform === "win32" ? "rg.exe" : "rg"))});`,
		"spawn-failure-shell": `rejectWithSpawnFailure(${JSON.stringify(join(root, "missing-bin", "zsh"))});`,
	};
	const result = spawnSync(
		process.execPath,
		[
			"--eval",
			`import { postmortem } from "@oh-my-pi/pi-utils";
import { installCursorSdkProcessErrorGuard, installCursorSdkSessionProcessErrorGuard } from ${JSON.stringify(GUARD_URL)};
import { readMissingFile, rejectWithAbort, rejectWithConnectUnavailable, rejectWithSpawnFailure, writeAfterClose } from ${JSON.stringify(pathToFileURL(fixturePath).href)};
// Referenced so Bun's import elision keeps the guard module loaded when the setup does not use it.
void installCursorSdkProcessErrorGuard;
void installCursorSdkSessionProcessErrorGuard;
// Registered before the guard, so it sees every rejection first and never claims one.
const rejectionReachedHost = new Promise((resolve) => {
	postmortem.interceptUnhandledRejections((reason) => {
		resolve(reason);
		return false;
	});
});
${options.guardSetup}
${actions[options.action]}
const reason = await rejectionReachedHost;
console.log("host handler saw: " + (typeof reason.code === "string" ? reason.code : reason.name));
`,
		],
		{ cwd: REPO, env: childEnv(root), encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/**
 * Drives the installed SDK's own startup walk in a Bun process that imports omp's real postmortem
 * handlers: a local agent in a git workspace whose CURSOR_RIPGREP_PATH names a binary that does not
 * exist. No Cursor guard is installed, so a rejection the SDK leaves unhandled reaches omp's handler and
 * exits the process. The child runs with no API key (the script deletes it after Bun has loaded any
 * `.env` from the repo), so `Agent.create` builds the local runtime without the keyed bootstrap, and
 * its first `send` starts the workspace walk (ignore files, rules, skills and nested AGENTS.md) that
 * spawns ripgrep. The walk reports its failure as `console.error("Error initializing ignore mapping
 * for <file>:", error)` for `.gitignore` and `.cursorignore`, which is how the child knows it ended; it
 * then waits 500 ms for a late rejection. After `send` the SDK also POSTs
 * `auth/exchange_user_api_key` to Cursor's backend through `fetch`, which Bun routes through the proxy
 * variables: lowercase ones win over uppercase ones, and a NO_PROXY that names the host skips the proxy.
 * The child gets every spelling pointed at a closed port and a NO_PROXY that names only `localhost`.
 * Both are set rather than deleted because the repo's `.env`, which Bun loads for any key that is unset
 * and pi-utils for any key that is unset or empty, could otherwise supply a NO_PROXY of its own. So the
 * request cannot leave the machine, and the walk does not wait on it.
 */
function runRipgrepStartupWalk(): ChildRun & { missingRipgrep: string } {
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
			`import { postmortem } from "@oh-my-pi/pi-utils";
import { Agent } from "@cursor/sdk";
// Registered with no Cursor guard, so omp's own handler decides: it exits the process on a rejection nobody claims.
const rejections = [];
postmortem.interceptUnhandledRejections((reason) => {
	rejections.push(reason.code + " " + reason.syscall);
	return false;
});
const failedWalks = new Set();
const forwardConsoleError = console.error;
const walksFailed = new Promise((resolve) => {
	console.error = (...args) => {
		forwardConsoleError.apply(console, args);
		const walk = typeof args[0] === "string" ? /^Error initializing ignore mapping for (\\S+):$/.exec(args[0]) : null;
		if (!walk) return;
		failedWalks.add(walk[1]);
		if (failedWalks.has(".gitignore") && failedWalks.has(".cursorignore")) resolve();
	};
});
// Bun and omp load a \`.env\` from the working directory at startup; a maintainer's key must not reach the SDK.
delete process.env.CURSOR_API_KEY;
const agent = await Agent.create({ model: { id: "composer-2-5" }, local: { cwd: ${JSON.stringify(workspace)}, settingSources: ["project"] } });
void agent.send("walk the workspace").catch(() => undefined);
await Promise.race([walksFailed, new Promise((resolve) => setTimeout(resolve, 20_000))]);
// A rejection the walk leaves unhandled arrives within a few macrotask turns of the failure. The wait is a real
// timer on purpose: that something does not happen cannot be awaited, and fake timers do not move a Bun child's clock.
await new Promise((resolve) => setTimeout(resolve, 500));
console.log("walks that failed: " + [...failedWalks].sort().join(" "));
console.log("rejections that reached the host: " + rejections.length + " " + rejections.join(", "));
process.exit(0);
`,
		],
		{ cwd: REPO, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
	);
	return { status: result.status, output: `${result.stdout}\n${result.stderr}`, missingRipgrep };
}

describe("Cursor SDK shell spawn failures", () => {
	it("still forwards the shell tool's stream error to its readers through the installed SDK's replay cache", () => {
		const { closedErrorClass, writableFactory, replayCacheClass, replayCacheDeclaration } = sdkExecShape();

		// The shell stream executor is registered through the streaming replay cache, which wraps the
		// executor's stream in the replay cache class and hands every reader a fork of it.
		const cache = onlyMatch(
			SDK_BUNDLE,
			`function (${IDENT})\\((${IDENT}),(${IDENT})\\)\\{let (${IDENT})=new ${IDENT}\\(\\{max:\\3\\?\\.max\\?\\?10,ttl:\\3\\?\\.ttl\\}\\);return\\{async\\*execute\\((${IDENT}),(${IDENT}),(${IDENT})\\)\\{` +
				`if\\(!\\7\\?\\.execId\\)\\{yield\\*\\2\\.execute\\(\\5,\\6,\\7\\);return\\}[^]{0,200}?` +
				`let (${IDENT})=\\2\\.execute\\(\\5,\\6,\\7\\),(${IDENT})=new ${escapeRegExp(replayCacheClass)}\\(\\8\\);\\4\\.set\\(${IDENT},\\9\\),yield\\*\\9\\.fork\\(\\)\\}\\}\\}`,
			"the streaming exec cache wraps the executor's stream in the replay cache class",
		);
		onlyMatch(
			SDK_BUNDLE,
			`let (${IDENT})=new ${IDENT}\\(this\\.permissionsService,${IDENT},this\\.ignoreService,this\\.backgroundShellExecutor\\.getManager\\(\\)\\);if\\(this\\.register\\(${IDENT},${escapeRegExp(cache[1]!)}\\(\\1\\)\\)`,
			"the shell stream executor is registered through the streaming exec cache",
		);

		// The replay cache keeps a failed source's error and throws it into every current and later reader.
		expect(replayCacheDeclaration).toMatch(new RegExp(`constructor\\((${IDENT})\\)\\{this\\.consume\\(\\1\\)\\}`));
		expect(replayCacheDeclaration).toMatch(new RegExp(`catch\\((${IDENT})\\)\\{this\\.error=\\1 instanceof Error\\?\\1:Error\\(String\\(\\1\\)\\)\\}`));
		expect(replayCacheDeclaration).toMatch(new RegExp(`for\\(let (${IDENT}) of this\\.forks\\)if\\(this\\.error\\)\\1\\.throw\\(this\\.error\\);else \\1\\.close\\(\\)`));
		expect(replayCacheDeclaration).toMatch(new RegExp(`for\\(let (${IDENT}) of (${IDENT})\\)yield \\1;if\\((${IDENT})\\)throw \\3`));

		// A tool stream that fails becomes a `throw` frame to the model, except the closed-writable error, which is dropped.
		onlyMatch(
			SDK_BUNDLE,
			`catch\\((${IDENT})\\)\\{if\\(\\1 instanceof ${escapeRegExp(closedErrorClass)}\\)return;[^]{0,120}?await (${IDENT})\\.write\\(new ${IDENT}\\(\\{message:\\{case:"throw"`,
			"a failed tool stream is written to the model as a throw frame",
		);

		// ZshState.execute (the local shell) arms the spawn error onto the writable the stream drains,
		// spawns in the requested working directory, and does not pre-check that directory itself.
		const zshIndex = SDK_BUNDLE.indexOf('.withName("ZshState.execute")');
		expect(zshIndex, "ZshState.execute exists").toBeGreaterThan(0);
		expect(SDK_BUNDLE.indexOf('.withName("ZshState.execute")', zshIndex + 1), "one ZshState.execute").toBe(-1);
		const zshExecute = declarationAt(SDK_BUNDLE.lastIndexOf("async*execute(", zshIndex));
		const stream = onlyMatch(zshExecute, `let (${IDENT})=${escapeRegExp(writableFactory)}\\(\\);`, "ZshState.execute drains a writable iterable");
		const cwd = onlyMatch(zshExecute, `let (${IDENT})=${IDENT}\\?\\.workingDirectory\\?\\?this\\.cwd;`, "the working directory is the request's, else the shell's");
		onlyMatch(zshExecute, `cwd:${escapeRegExp(cwd[1]!)},detached:!0\\}`, "the shell spawns in that working directory");
		onlyMatch(
			zshExecute,
			`${IDENT}\\.on\\("error",\\((${IDENT})\\)=>\\{${escapeRegExp(stream[1]!)}\\.throw\\(\\1\\)\\}\\)`,
			"a spawn error is thrown into the writable the stream drains",
		);
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
	it("bundled build: every ripgrep spawn handles the child's 'error' event, so none can leave an unhandled spawn rejection", () => {
		// Every spawn of the resolved ripgrep goes through this accessor, as `<spawn>(ACC(),args,...)` or `<spawn>(<helper>,ACC(),args,...)`.
		const accessor = onlyMatch(
			SDK_BUNDLE,
			`function (${IDENT})\\(\\)\\{if\\(!${IDENT}\\)throw Error\\("Ripgrep path not configured\\. Call configureRipgrepPath\\(\\) at startup\\."\\);return ${IDENT}\\}`,
			"the resolved ripgrep path accessor",
		);
		const spawns = [...SDK_BUNDLE.matchAll(new RegExp(`(${IDENT})=${IDENT}\\((?:${IDENT},)?${escapeRegExp(accessor[1]!)}\\(\\),`, "g"))];
		// The workspace walk and `ls` (the ripwalk), Grep, and the content search. A new spawn site is one to measure.
		expect(spawns, "ripgrep is spawned from exactly three places").toHaveLength(3);
		for (const spawn of spawns) {
			// Minified names are reused from function to function, so the listener has to be in the function that spawned.
			const executor = enclosingFunctionText(spawn.index!);
			expect(executor, `the ripgrep child ${spawn[1]} gets an 'error' listener in the function that spawns it`).toMatch(
				new RegExp(`(?<![\\w$.])${escapeRegExp(spawn[1]!)}\\.on\\("error",`),
			);
		}
	});

	it.each(CURSOR_SDK_BUILDS)(
		"%s build: the ripwalk observes its processExit promise where it spawns, so the guard needs no ripgrep case",
		(build) => {
			const files = readCursorSdkBuildFiles(build);
			const wanted = files.filter(({ source }) => source.includes("No stdout from ripgrep process"));
			expect(wanted.map(({ name }) => name), `${build}: one file holds the ripwalk`).toHaveLength(1);
			const { name, source } = wanted[0]!;

			const walk = onlyMatch(source, PROCESS_EXIT_OBSERVED_AT_SPAWN.source, `${build}/${name}: processExit gets a rejection handler when it is created`);
			// The promise is the one handed to the walk, which awaits it only after stdout has ended and no line was read.
			onlyMatch(source, `processExit:${escapeRegExp(walk[1]!)},`, `${build}/${name}: that promise is the walk's processExit`);
			onlyMatch(source, `if\\(${IDENT}>0\\);else if\\(!${IDENT}\\)\\{(?:let|const) ${IDENT}=await ${IDENT}\\.processExit;`, `${build}/${name}: the walk awaits processExit after stdout ends`);
			// A new reader or a different spawn of the ripwalk is a change to re-measure.
			const processExitUses = files.reduce((total, file) => total + file.source.split("processExit").length - 1, 0);
			expect(processExitUses, `${build}: processExit appears in its definition and its one await`).toBe(2);
		},
	);

	it("keeps omp alive on the installed SDK's startup walk when ripgrep cannot start, with no Cursor guard", () => {
		const run = runRipgrepStartupWalk();

		expect(run.status, run.output).toBe(0);
		expect(run.output).not.toContain("[Unhandled Rejection]");
		// Both walks ran against the missing ripgrep and failed inside the SDK, which reported it and went on.
		expect(run.output).toContain("walks that failed: .cursorignore .gitignore");
		expect(run.output).toContain("rejections that reached the host: 0");
		expect(run.output).toContain("ERR_STREAM_PREMATURE_CLOSE");
		expect(existsSync(run.missingRipgrep)).toBe(false);
	}, TEST_TIMEOUT_MS);
});

// The guard contains two raw SDK failures that surface after a tool call's stream ended. A `write EPIPE` (only in the
// exact shape of a spawned child's stdin write that completes after the child exited,
// `isObservedLocalTransportClosedPipeWriteError`) rests on the premise below: the SDK writes children's stdin from a
// few places and, in the shell executor's case, without a stream 'error' listener, so a child that exits mid-write
// surfaces as an uncaught EPIPE. The MCP stdio transport, by contrast, attaches its own stdin error listener and needs
// no containment; the hook payload path treats EPIPE as a normal outcome. Every `.stdin.write(` of the SDK is
// classified, so a new one is a site to measure, not one to wave through. The `WriteIterableClosedError` rests on the
// controlled-exec stream: it swallows that error itself and sends every other one to the model.
describe("Cursor SDK local-executor stdio errors (the closed-pipe and closed-writable premises)", () => {
	/** The shell executor's `child.stdin.write(data, (error) => error ? reject(error) : resolve())`, as each build minifies it. */
	const SHELL_STDIN_WRITE = new RegExp(
		`(${IDENT})\\.stdin\\.write\\(${IDENT},\\(?\\(?(${IDENT})\\)?=>\\{(?:\\2\\?${IDENT}\\(\\2\\):${IDENT}\\(void 0\\)|if\\(\\2\\)${IDENT}\\(\\2\\);else ${IDENT}\\(void 0\\))\\}\\)?\\)`,
		"g",
	);
	/** `git check-attr --stdin`: the path list is written and the stream ended in one statement, with no listener. */
	const GIT_STDIN_WRITE = new RegExp(`(${IDENT})\\.stdin\\.write\\(\`\\$\\{${IDENT}\\.join\\([^)]*\\)\\}[^\`]*\`\\),\\1\\.stdin\\.end\\(\\)`, "g");
	/** The MCP stdio transport's request write. */
	const MCP_STDIN_WRITE = /this\._process\.stdin\.write\(/g;
	const STDIN_ERROR_LISTENER = /stdin\??\.(?:on|once|addListener|prependListener)\(["']error["']/g;
	const MCP_STDIN_ERROR_LISTENER = /this\._process\.stdin\?\.on\("error",\(?\(?[\w$]+\)?(?:=>\{this\.onerror\?\.\([\w$]+\)\}|=>\{this\.onerror\?\.\([\w$]+\)\})\)?\)/g;

	it.each(CURSOR_SDK_BUILDS)("%s build: the only spawned-child stdin writes are the shell executor's two, git's one and the MCP transport's one", (build) => {
		const source = readCursorSdkBuildSource(build);
		const writes = source.match(/\.stdin\.write\(/g) ?? [];

		expect([...source.matchAll(SHELL_STDIN_WRITE)], `${build}: the shell executor writes the stdin of the shell it spawned, with a result callback`).toHaveLength(2);
		expect(source.split('"Shell stdin not available"').length - 1, `${build}: that writer is the shell executor's stdin writer`).toBe(1);
		expect([...source.matchAll(GIT_STDIN_WRITE)], `${build}: git check-attr's stdin`).toHaveLength(1);
		expect([...source.matchAll(MCP_STDIN_WRITE)], `${build}: the MCP stdio transport's request write`).toHaveLength(1);
		expect(writes, `${build}: every .stdin.write( of the SDK is classified above; a new one can surface a raw EPIPE and needs measuring`).toHaveLength(4);
	});

	it.each(CURSOR_SDK_BUILDS)("%s build: no spawned child's stdin gets an 'error' listener except the MCP stdio transport's", (build) => {
		const source = readCursorSdkBuildSource(build);

		expect(source.match(STDIN_ERROR_LISTENER) ?? [], `${build}: stdin error listeners`).toHaveLength(1);
		expect([...source.matchAll(MCP_STDIN_ERROR_LISTENER)], `${build}: that listener is the MCP stdio transport's`).toHaveLength(1);
	});

	it.each(CURSOR_SDK_BUILDS)("%s build: the hook payload path ends stdin once and treats a closed pipe as a normal outcome", (build) => {
		const source = readCursorSdkBuildSource(build);
		const start = source.indexOf("async writeCommandHookStdinPayload(");
		expect(start, `${build}: writeCommandHookStdinPayload is declared`).toBeGreaterThanOrEqual(0);
		expect(source.indexOf("async writeCommandHookStdinPayload(", start + 1), `${build}: declared once`).toBe(-1);
		expect(source.split("writeCommandHookStdinPayload").length - 1, `${build}: declared once and called once`).toBe(2);
		const body = balancedDeclaration(source, start);

		expect(body).toMatch(new RegExp(`${IDENT}\\.end\\(Buffer\\.from\\(${IDENT},"utf8"\\)\\)`));
		for (const code of ["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE"]) {
			expect(body, `${build}: ${code} is swallowed`).toContain(`"${code}"`);
		}
	});

	it.each(CURSOR_SDK_BUILDS)("%s build: the controlled-exec stream drops the closed-writable error and sends any other to the model as a throw frame", (build) => {
		const source = readCursorSdkBuildSource(build);

		expect(source.split('this.name="WriteIterableClosedError"').length - 1, `${build}: the closed-writable error class`).toBe(1);
		expect(source, `${build}: the writable iterable raises it with its message`).toContain('"WritableIterable is closed"');
		expect(source, `${build}: a failed tool stream ignores that error and writes any other as a throw frame`).toMatch(
			new RegExp(`catch\\((${IDENT})\\)\\{if\\(\\1 instanceof ${IDENT}(?:\\.${IDENT})?\\)return;[^]{0,120}?await ${IDENT}\\.write\\(new ${IDENT}(?:\\.${IDENT})?\\(\\{message:\\{case:"throw"`),
		);
	});
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

	// The guard has no spawn case, so a spawn error with SDK stack provenance stays fatal whatever file it names.
	it.each([
		["a ripgrep", "spawn-failure-ripgrep"],
		["a shell", "spawn-failure-shell"],
	] as const)("keeps %s spawn rejection from Cursor's SDK fatal while the guard is active", (_name, action) => {
		const run = runInOmpHost({ guardSetup: "installCursorSdkProcessErrorGuard();", action });

		expect(run.status).toBe(1);
		expect(run.output).toContain("host handler saw: ENOENT");
		expect(run.output).toContain("[Unhandled Rejection]");
	}, TEST_TIMEOUT_MS);
});
