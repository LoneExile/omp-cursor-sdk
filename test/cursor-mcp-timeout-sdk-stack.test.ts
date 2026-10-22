import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cursorMcpToolTimeoutOverrideDefaults,
	installCursorMcpToolTimeoutOverride,
	isCursorSdkMcpConnectTimeoutStack,
	isCursorSdkMcpToolTimeoutStack,
	restoreCursorMcpToolTimeoutOverride,
} from "../src/cursor-mcp-timeout-override.js";

// The SDK minifies its MCP client (`class y extends d` in the webpack esm/cjs chunks,
// `class R11 extends L11` in the Bun bundle), so the override cannot recognize a timeout by
// class name. These tests (1) pin, for every build of the installed SDK, the layout the
// matchers rely on, and (2) run minified-shaped code, built from the class names read out of
// that build and loaded from the build's own SDK-looking path, and classify the stacks Bun
// actually produces. Bun resolves `@cursor/sdk` to the bundled build (package.json
// `exports["."].bun`), so that build is the one omp runs; esm and cjs are what Node consumers
// load and are covered because they ship in the same package.

type SdkBuild = "bundled" | "esm" | "cjs";

const SDK_BUILDS: readonly SdkBuild[] = ["bundled", "esm", "cjs"];
const SDK_BUILD_SCAN_TIMEOUT_MS = 30_000;
const SDK_PACKAGE_DIR = join(process.cwd(), "node_modules", "@cursor", "sdk");
const CLASS_HEADER = /class ([\w$]+)(?: extends ([\w$.]+))?\{/g;
const SDK_DEFAULT_MS = cursorMcpToolTimeoutOverrideDefaults.cursorSdkDefaultTimeoutMs;
// Distinct from the SDK default and from each other so a recorded delay names its matcher.
const TOOL_OVERRIDE_MS = 3_599_000;
const CONNECT_OVERRIDE_MS = 7_777;

// Property names survive minification; only class and local names are mangled.
const METHOD = {
	setupTimeout: "_setupTimeout",
	request: "request",
	connect: "connect",
	listTools: "listTools",
	callTool: "callTool",
	listPrompts: "listPrompts",
	getTools: "getTools",
} as const;

interface ClassHeader {
	name: string;
	base: string | undefined;
	index: number;
}

interface MethodDefinition {
	index: number;
	header: ClassHeader;
}

interface SdkMcpLayout {
	build: SdkBuild;
	protocolFileName: string;
	wrapperFileName: string;
	baseClass: string;
	clientClass: string;
	wrapperClass: string;
}

function layoutError(message: string): never {
	throw new Error(`Installed @cursor/sdk MCP layout drifted: ${message}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sourceCache = new Map<string, string>();

function readSdkChunk(build: SdkBuild, markers: readonly string[]): { fileName: string; source: string } {
	const dir = join(SDK_PACKAGE_DIR, "dist", build);
	const hits = readdirSync(dir)
		.filter((fileName) => fileName.endsWith(".js"))
		.map((fileName) => {
			const filePath = join(dir, fileName);
			let source = sourceCache.get(filePath);
			if (source === undefined) {
				source = readFileSync(filePath, "utf8");
				sourceCache.set(filePath, source);
			}
			return { fileName, source };
		})
		.filter(({ source }) => markers.every((marker) => source.includes(marker)));
	if (hits.length !== 1) {
		layoutError(
			`${build}: expected exactly one chunk containing ${JSON.stringify(markers)}, found ${hits.map((hit) => hit.fileName).join(", ") || "none"}`,
		);
	}
	return hits[0]!;
}

function classHeaders(source: string, before: number): ClassHeader[] {
	const headers: ClassHeader[] = [];
	for (const match of source.matchAll(CLASS_HEADER)) {
		if (match.index === undefined || match.index >= before) break;
		headers.push({ name: match[1]!, base: match[2], index: match.index });
	}
	return headers;
}

function classHeaderBefore(source: string, index: number): ClassHeader {
	return classHeaders(source, index).at(-1) ?? layoutError(`no class declaration before offset ${index}`);
}

function findMethodDefinitions(source: string, name: string, isAsync: boolean): MethodDefinition[] {
	const pattern = new RegExp(`(?<![\\w$.])${isAsync ? "async " : ""}${name}\\([^()]*\\)\\{`, "g");
	return [...source.matchAll(pattern)].map((match) => ({
		index: match.index ?? layoutError(`regex match without index for ${name}`),
		header: classHeaderBefore(source, match.index ?? 0),
	}));
}

function onlyMethodIn(source: string, header: ClassHeader, name: string, isAsync: boolean): MethodDefinition {
	const definitions = findMethodDefinitions(source, name, isAsync).filter((definition) => definition.header.index === header.index);
	if (definitions.length !== 1) {
		layoutError(`expected exactly one ${isAsync ? "async " : ""}${name}() in class ${header.name}, found ${definitions.length}`);
	}
	return definitions[0]!;
}

function expectWindow(source: string, from: number, length: number, needle: string | RegExp, what: string): string {
	const window = source.slice(from, from + length);
	const found = typeof needle === "string" ? window.includes(needle) : needle.test(window);
	if (!found) layoutError(`${what}: expected ${String(needle)} within ${length} chars`);
	return window;
}

// `?.timeout??6e4` in the webpack chunks, `?.timeout??kY6` plus `var kY6=60000` in the Bun bundle.
function resolveDefaultTimeoutMs(source: string, token: string): number {
	if (/^\d/.test(token)) return Number(token);
	const definitions = [...source.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(token)}=(\\d[\\d.e]*)(?![\\w$.])`, "g"))];
	if (definitions.length !== 1) layoutError(`expected exactly one definition of ${token}, found ${definitions.length}`);
	return Number(definitions[0]![1]);
}

const layoutCache = new Map<SdkBuild, SdkMcpLayout>();

function readSdkMcpLayout(build: SdkBuild): SdkMcpLayout {
	const cached = layoutCache.get(build);
	if (cached) return cached;

	const protocol = readSdkChunk(build, ['this.request({method:"initialize"', "async listTools(", "_setupTimeout("]);
	const source = protocol.source;

	// `listTools`, `callTool` and `connect` live on the Client subclass; `request`,
	// `_setupTimeout` and the base `connect` live on its protocol base class.
	const listToolsDefinitions = findMethodDefinitions(source, METHOD.listTools, true);
	if (listToolsDefinitions.length !== 1) layoutError(`${build}: expected one async listTools(), found ${listToolsDefinitions.length}`);
	const clientHeader = listToolsDefinitions[0]!.header;
	if (!clientHeader.base) layoutError(`${build}: class ${clientHeader.name} (owner of listTools) has no base class`);
	const baseHeader = classHeaders(source, clientHeader.index).filter((header) => header.name === clientHeader.base).at(-1);
	if (!baseHeader) layoutError(`${build}: base class ${clientHeader.base} is not declared before ${clientHeader.name}`);
	if (baseHeader.base !== undefined) layoutError(`${build}: protocol base class ${baseHeader.name} unexpectedly extends ${baseHeader.base}`);

	// Base class: request() arms the SDK's 60s default through _setupTimeout. setTimeout is
	// called inside an object literal, not as `return setTimeout(...)`: a tail call would
	// drop the _setupTimeout frame from the stack in JavaScriptCore, and the matcher needs
	// that frame. The delay is _setupTimeout's second parameter, the handler its fourth.
	const setupTimeout = onlyMethodIn(source, baseHeader, METHOD.setupTimeout, false);
	expectWindow(
		source,
		setupTimeout.index,
		300,
		/^_setupTimeout\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)(?:,[^)]*)?\)\{[^}]*?timeoutId:setTimeout\(\4,\2\)/,
		`${build}: _setupTimeout`,
	);
	const request = onlyMethodIn(source, baseHeader, METHOD.request, false);
	expectWindow(source, request.index, 400, "return new Promise(", `${build}: request`);
	const requestBody = source.slice(request.index, request.index + 3000);
	const defaulted = /([\w$]+)=[\w$]+\?\.timeout\?\?([\w$.]+)/.exec(requestBody);
	if (!defaulted) layoutError(`${build}: request has no \`?.timeout??<default>\` binding`);
	if (!new RegExp(`this\\._setupTimeout\\([\\w$]+,${escapeRegExp(defaulted[1]!)},`).test(requestBody)) {
		layoutError(`${build}: request does not pass its defaulted timeout \`${defaulted[1]}\` to _setupTimeout`);
	}
	const defaultMs = resolveDefaultTimeoutMs(source, defaulted[2]!);
	if (defaultMs !== SDK_DEFAULT_MS) {
		layoutError(`${build}: request default timeout is ${defaultMs}, the override intercepts ${SDK_DEFAULT_MS}`);
	}
	onlyMethodIn(source, baseHeader, METHOD.connect, true);

	// Client class: every protocol entry point is an `async` method (a non-async
	// `return this.request(...)` could be tail-called away and lose its stack frame in
	// JavaScriptCore) that awaits this.request, and connect resumes after `await super.connect`.
	const connect = onlyMethodIn(source, clientHeader, METHOD.connect, true);
	const connectWindow = expectWindow(source, connect.index, 500, /await this\.request\(\{method:"initialize"/, `${build}: client connect`);
	const superConnectAt = connectWindow.indexOf("await super.connect(");
	if (superConnectAt < 0 || superConnectAt > connectWindow.indexOf('this.request({method:"initialize"')) {
		layoutError(`${build}: client connect does not await super.connect() before the initialize request`);
	}
	const listTools = onlyMethodIn(source, clientHeader, METHOD.listTools, true);
	expectWindow(source, listTools.index, 200, /await this\.request\(\{method:"tools\/list"/, `${build}: client listTools`);
	const callTool = onlyMethodIn(source, clientHeader, METHOD.callTool, true);
	expectWindow(source, callTool.index, 600, /await this\.request\(\{method:"tools\/call"/, `${build}: client callTool`);
	const listPrompts = onlyMethodIn(source, clientHeader, METHOD.listPrompts, true);
	expectWindow(source, listPrompts.index, 200, 'this.request({method:"prompts/list"', `${build}: client listPrompts`);

	// The agent-side McpSdkClient wrapper reaches those protocol methods; "McpSdkClient"
	// itself only appears as a tracing span name, never as a class.
	const wrapperChunk = readSdkChunk(build, [
		'withName("McpSdkClient.getTools")',
		"this.client.listTools({cursor:",
		"this.client.callTool({name:",
	]);
	const wrapperSource = wrapperChunk.source;
	if (/class McpSdkClient\b/.test(wrapperSource)) layoutError(`${build}: McpSdkClient is a class name now`);
	const spanIndex = wrapperSource.indexOf('withName("McpSdkClient.getTools")');
	const wrapperHeader = classHeaderBefore(wrapperSource, spanIndex);
	const getTools = onlyMethodIn(wrapperSource, wrapperHeader, METHOD.getTools, true);
	expectWindow(wrapperSource, getTools.index, 1500, /this\.client\.listTools\(\{cursor:[\w$]+\}\)/, `${build}: wrapper getTools`);
	const wrapperCallTool = onlyMethodIn(wrapperSource, wrapperHeader, METHOD.callTool, true);
	expectWindow(
		wrapperSource,
		wrapperCallTool.index,
		4000,
		/this\.client\.callTool\(\{name:[\w$]+,arguments:[\w$]+\}\)/,
		`${build}: wrapper callTool`,
	);

	const layout: SdkMcpLayout = {
		build,
		protocolFileName: protocol.fileName,
		wrapperFileName: wrapperChunk.fileName,
		baseClass: baseHeader.name,
		clientClass: clientHeader.name,
		wrapperClass: wrapperHeader.name,
	};
	layoutCache.set(build, layout);
	return layout;
}

// Minified-shaped stand-in: same class hierarchy and method names as the installed
// build (real names for classes, real property names for methods), same async/await
// structure around request(), and the same non-tail `timeoutId:setTimeout(...)` call at
// the protocol layer. Only the transport and schema work is dropped.
function protocolModuleSource(layout: SdkMcpLayout): string {
	const { baseClass: base, clientClass: client } = layout;
	return `
class ${base}{
	constructor(){this.stacks=[];this._timeoutInfo=new Map}
	${METHOD.setupTimeout}(e,t,s,n,r=!1){this.stacks.push(new Error().stack);this._timeoutInfo.set(e,{timeoutId:setTimeout(n,t),startTime:Date.now(),timeout:t,maxTotalTimeout:s,resetTimeoutOnProgress:r,onTimeout:n})}
	async ${METHOD.connect}(e){await Promise.resolve()}
	${METHOD.request}(e,t,s){return new Promise((u,d)=>{const g=s?.timeout??6e4;this.${METHOD.setupTimeout}(1,g,void 0,()=>d(new Error("Request timed out")));u(e.method)})}
}
class ${client} extends ${base}{
	async ${METHOD.connect}(e,t){if(await super.${METHOD.connect}(e),void 0===e.sessionId){const s=await this.${METHOD.request}({method:"initialize"},1,t);return s}}
	async ${METHOD.listTools}(e,t){const s=await this.${METHOD.request}({method:"tools/list",params:e},1,t);return s}
	async ${METHOD.callTool}(e,t,s){const n=await this.${METHOD.request}({method:"tools/call",params:e},t,s);return n}
	async ${METHOD.listPrompts}(e,t){return this.${METHOD.request}({method:"prompts/list",params:e},1,t)}
}
export { ${client} as Client };
`;
}

// `Ancestor` puts an SDK-path frame named like a protocol method above whatever `fn` calls,
// as an agent-side wrapper that connects or lists tools while serving a tool call would.
function wrapperModuleSource(layout: SdkMcpLayout): string {
	return `
async function paginate({fetchPage:e}){return await e(void 0)}
class ${layout.wrapperClass}{
	constructor(e){this.client=e}
	async ${METHOD.getTools}(){return await paginate({fetchPage:e=>this.client.${METHOD.listTools}({cursor:e})})}
	async ${METHOD.callTool}(e,t){return await this.client.${METHOD.callTool}({name:e,arguments:t})}
}
class Ancestor{
	async ${METHOD.connect}(fn){return await fn()}
	async ${METHOD.listTools}(fn){return await fn()}
	async ${METHOD.callTool}(fn){return await fn()}
}
export { ${layout.wrapperClass} as Wrapper, Ancestor };
`;
}

// An SDK protocol call reached from a host (non-SDK) frame that happens to be named `connect`.
const HOST_MODULE_SOURCE = `
export class Host{
	async connect(client){return await client.listPrompts({})}
}
`;

interface SyntheticClient {
	stacks: string[];
	connect(transport: object): Promise<unknown>;
	listTools(params?: object): Promise<unknown>;
	callTool(params?: object): Promise<unknown>;
	listPrompts(params?: object): Promise<unknown>;
}

interface SyntheticWrapper {
	getTools(): Promise<unknown>;
	callTool(name: string, args: object): Promise<unknown>;
}

interface SyntheticAncestor {
	connect(fn: () => Promise<unknown>): Promise<unknown>;
	listTools(fn: () => Promise<unknown>): Promise<unknown>;
	callTool(fn: () => Promise<unknown>): Promise<unknown>;
}

interface SyntheticHost {
	connect(client: SyntheticClient): Promise<unknown>;
}

interface Fixture {
	Client: new () => SyntheticClient;
	Wrapper: new (client: SyntheticClient) => SyntheticWrapper;
	Ancestor: new () => SyntheticAncestor;
}

interface ScenarioContext {
	client: SyntheticClient;
	wrapper: SyntheticWrapper;
	ancestor: SyntheticAncestor;
	host: SyntheticHost;
}

type FixtureKind = "sdk" | "plain";

let tmpRoot: string | undefined;
const fixtures = new Map<string, Fixture>();
let HostClass: (new () => SyntheticHost) | undefined;

function writeModule(filePath: string, source: string): string {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, source);
	return pathToFileURL(filePath).href;
}

// The module text and path are generated at test time (class names come from the
// installed build, the path decides whether the stack looks like the SDK's), so a
// static import cannot express this. Every module of a directory is written before the
// first import: Bun caches a directory listing at first resolve, so a sibling written
// afterwards is "Cannot find module". The bundled build keeps protocol and wrapper in one
// file; the webpack builds split them into chunks.
async function loadFixture(root: string, layout: SdkMcpLayout): Promise<Fixture> {
	const sources = new Map<string, string>();
	for (const [fileName, source] of [
		[layout.protocolFileName, protocolModuleSource(layout)],
		[layout.wrapperFileName, wrapperModuleSource(layout)],
	] as const) {
		sources.set(fileName, `${sources.get(fileName) ?? ""}${source}`);
	}
	const urls = [...sources].map(([fileName, source]) => writeModule(join(root, fileName), source));
	// Non-literal specifiers: `import()` is `Promise<any>`; the shapes are fixed by the sources written above.
	const loaded: Partial<Fixture>[] = [];
	for (const url of urls) loaded.push(await import(url));
	const fixture: Partial<Fixture> = Object.assign({}, ...loaded);
	if (!fixture.Client || !fixture.Wrapper || !fixture.Ancestor) throw new Error(`fixture exports missing for ${root}`);
	return { Client: fixture.Client, Wrapper: fixture.Wrapper, Ancestor: fixture.Ancestor };
}

function fixtureKey(build: SdkBuild, kind: FixtureKind): string {
	return `${build}:${kind}`;
}

// The path of the generated modules is what the stack reports: an SDK build directory
// under node_modules/@cursor/sdk/dist/<build>, or a vendored copy outside the SDK.
function fixtureRoot(root: string, build: SdkBuild, kind: FixtureKind): string {
	return kind === "sdk" ? join(root, build, "node_modules", "@cursor", "sdk", "dist", build) : join(root, build, "vendored");
}

// Runs `call` with the real override installed over a recording setTimeout. Only the
// probe delays are intercepted (and never armed); every other timer passes through.
async function observeSdkTimer(
	build: SdkBuild,
	kind: FixtureKind,
	call: (context: ScenarioContext) => Promise<unknown>,
): Promise<{ stack: string; delays: unknown[] }> {
	const fixture = fixtures.get(fixtureKey(build, kind));
	if (!fixture || !HostClass) throw new Error("fixtures not loaded");
	const client = new fixture.Client();
	const context: ScenarioContext = {
		client,
		wrapper: new fixture.Wrapper(client),
		ancestor: new fixture.Ancestor(),
		host: new HostClass(),
	};

	// A leaked install from another test file would make the recorder below shadow it.
	restoreCursorMcpToolTimeoutOverride();
	const realSetTimeout = globalThis.setTimeout;
	const probeDelays = new Set<unknown>([SDK_DEFAULT_MS, TOOL_OVERRIDE_MS, CONNECT_OVERRIDE_MS]);
	const delays: unknown[] = [];
	globalThis.setTimeout = ((handler: unknown, delay?: unknown, ...args: unknown[]) => {
		if (probeDelays.has(delay)) {
			delays.push(delay);
			return 0;
		}
		return Reflect.apply(realSetTimeout, globalThis, [handler, delay, ...args]);
	}) as unknown as typeof setTimeout;
	try {
		installCursorMcpToolTimeoutOverride({ timeoutMs: TOOL_OVERRIDE_MS, connectTimeoutMs: CONNECT_OVERRIDE_MS });
		await call(context);
	} finally {
		restoreCursorMcpToolTimeoutOverride();
		globalThis.setTimeout = realSetTimeout;
	}

	expect(client.stacks).toHaveLength(1);
	return { stack: client.stacks[0]!, delays };
}

type Purpose = "connect" | "tool" | "neither";

const EXPECTED_DELAY_MS: Record<Purpose, number> = {
	connect: CONNECT_OVERRIDE_MS,
	tool: TOOL_OVERRIDE_MS,
	neither: SDK_DEFAULT_MS,
};

interface Scenario {
	name: string;
	kind: FixtureKind;
	purpose: Purpose;
	call: (context: ScenarioContext) => Promise<unknown>;
}

const SCENARIOS: Scenario[] = [
	{
		name: "initialize: connect() resumed after `await super.connect`",
		kind: "sdk",
		purpose: "connect",
		call: ({ client }) => client.connect({}),
	},
	{ name: "tools/list: listTools()", kind: "sdk", purpose: "connect", call: ({ client }) => client.listTools({}) },
	{
		name: "tools/list: listTools() reached through the McpSdkClient getTools wrapper",
		kind: "sdk",
		purpose: "connect",
		call: ({ wrapper }) => wrapper.getTools(),
	},
	{ name: "tools/call: callTool()", kind: "sdk", purpose: "tool", call: ({ client }) => client.callTool({}) },
	{
		name: "tools/call: callTool() reached through the McpSdkClient callTool wrapper",
		kind: "sdk",
		purpose: "tool",
		call: ({ wrapper }) => wrapper.callTool("t", {}),
	},
	{
		name: "unknown protocol request: listPrompts() keeps the SDK default",
		kind: "sdk",
		purpose: "neither",
		call: ({ client }) => client.listPrompts({}),
	},
	{
		name: "unknown protocol request under a non-SDK frame named connect keeps the SDK default",
		kind: "sdk",
		purpose: "neither",
		call: ({ client, host }) => host.connect(client),
	},
	{
		name: "connect() resumed under an SDK callTool frame keeps the connect timeout",
		kind: "sdk",
		purpose: "connect",
		call: ({ client, ancestor }) => ancestor.callTool(() => client.connect({})),
	},
	{
		name: "callTool() under an SDK connect frame keeps the tool timeout",
		kind: "sdk",
		purpose: "tool",
		call: ({ client, ancestor }) => ancestor.connect(() => client.callTool({})),
	},
	{
		name: "unknown request under an SDK callTool frame keeps the SDK default",
		kind: "sdk",
		purpose: "neither",
		call: ({ client, ancestor }) => ancestor.callTool(() => client.listPrompts({})),
	},
	{
		name: "unknown request under an SDK listTools frame keeps the SDK default",
		kind: "sdk",
		purpose: "neither",
		call: ({ client, ancestor }) => ancestor.listTools(() => client.listPrompts({})),
	},
	{ name: "connect() outside an SDK path", kind: "plain", purpose: "neither", call: ({ client }) => client.connect({}) },
	{ name: "listTools() outside an SDK path", kind: "plain", purpose: "neither", call: ({ client }) => client.listTools({}) },
	{ name: "callTool() outside an SDK path", kind: "plain", purpose: "neither", call: ({ client }) => client.callTool({}) },
];

describe("Cursor SDK MCP layout contract", () => {
	it("resolves @cursor/sdk to the bundled build under Bun and ships esm and cjs builds", () => {
		const manifest = JSON.parse(readFileSync(join(SDK_PACKAGE_DIR, "package.json"), "utf8"));

		expect(manifest.exports["."].bun).toBe("./dist/bundled/index.js");
		expect(manifest.exports["."].import).toBe("./dist/esm/index.js");
		expect(manifest.exports["."].require).toBe("./dist/cjs/index.js");
		expect(import.meta.resolve("@cursor/sdk").replaceAll("\\", "/")).toMatch(
			/\/node_modules\/@cursor\/sdk\/dist\/bundled\/index\.js$/,
		);
	});

	// Scanning a multi-megabyte SDK build takes about 3 s unloaded, close to bun's 5 s default.
	for (const build of SDK_BUILDS) {
		it(
			`pins the installed ${build} build's MCP protocol layout the matchers rely on`,
			() => {
				const layout = readSdkMcpLayout(build);

				// The class names the old matcher looked for do not exist as classes in any build.
				for (const staleName of ["Client", "McpSdkClient", "Protocol"]) {
					expect([layout.baseClass, layout.clientClass, layout.wrapperClass]).not.toContain(staleName);
				}
			},
			SDK_BUILD_SCAN_TIMEOUT_MS,
		);
	}
});

// Hooks are scoped here so the frame-text tests below stay runnable when the layout drifts.
describe("Cursor SDK MCP stack classification", () => {
	beforeAll(async () => {
		// Import through the canonical path: Bun caches resolver directory entries by the path used,
		// so a /var vs /private/var alias here leaks into later files' module resolution.
		const root = mkdtempSync(join(realpathSync(tmpdir()), "omp-cursor-mcp-stack-"));
		tmpRoot = root;
		for (const build of SDK_BUILDS) {
			const layout = readSdkMcpLayout(build);
			for (const kind of ["sdk", "plain"] as const) {
				fixtures.set(fixtureKey(build, kind), await loadFixture(fixtureRoot(root, build, kind), layout));
			}
		}
		const hostUrl = writeModule(join(root, "host", "mcp-host.js"), HOST_MODULE_SOURCE);
		const hostModule: { Host: new () => SyntheticHost } = await import(hostUrl);
		HostClass = hostModule.Host;
	}, SDK_BUILD_SCAN_TIMEOUT_MS);

	afterAll(() => {
		restoreCursorMcpToolTimeoutOverride();
		if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	});

	for (const build of SDK_BUILDS) {
		describe(`${build} build`, () => {
			for (const scenario of SCENARIOS) {
				it(`classifies ${scenario.name}`, async () => {
					const { stack, delays } = await observeSdkTimer(build, scenario.kind, scenario.call);

					// Guard against a vacuous pass: the stack is the protocol-layer stack from the
					// expected path, and Bun's frames carry method names but no minified class names.
					expect(stack).toContain(METHOD.setupTimeout);
					expect(stack).toContain(METHOD.request);
					const normalized = stack.replaceAll("\\", "/");
					expect(normalized.includes(`node_modules/@cursor/sdk/dist/${build}/`)).toBe(scenario.kind === "sdk");

					expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(scenario.purpose === "connect");
					expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(scenario.purpose === "tool");
					// End to end: the installed override picks the matching delay for this stack.
					expect(delays).toEqual([EXPECTED_DELAY_MS[scenario.purpose]]);
				});
			}
		});
	}
});

// Frame text as printed by the runtimes. JSC (Bun 1.3.14) prints bare method names and
// `at async` for awaited ancestors; V8 (Node 26.3.0) prints `Class.method` with the
// minified class name. Both were captured from the minified-shaped modules above.
function stackWith(frames: string[]): string {
	return ["Error", ...frames.map((frame) => `    at ${frame}`)].join("\n");
}

const SDK_FILE = "/work/node_modules/@cursor/sdk/dist/esm/458.js";
const SDK_BUNDLED_FILE = "/work/node_modules/@cursor/sdk/dist/bundled/index.js";
const SDK_WRAPPER_FILE = "/work/node_modules/@cursor/sdk/dist/esm/479.js";
const SDK_WIN_FILE = "C:\\work\\node_modules\\@cursor\\sdk\\dist\\esm\\458.js";

function jscProtocolStack(method: string, file = SDK_FILE, ancestors: string[] = []): string {
	return stackWith([
		`_setupTimeout (${file}:1:82)`,
		`<anonymous> (${file}:1:209)`,
		"new Promise (native:1:11)",
		`request (${file}:1:187)`,
		`${method} (${file}:2:97)`,
		...ancestors,
	]);
}

function v8ProtocolStack(method: string, ancestors: string[] = []): string {
	return stackWith([
		`y._setupTimeout (file://${SDK_FILE}:1:78)`,
		`file://${SDK_FILE}:1:195`,
		"new Promise (<anonymous>)",
		`y.request (file://${SDK_FILE}:1:169)`,
		`y.${method} (file://${SDK_FILE}:2:97)`,
		...ancestors,
	]);
}

describe("Cursor SDK MCP stack frame formats", () => {
	it("matches connect and listTools frames in JSC and V8 formats", () => {
		for (const stack of [
			jscProtocolStack("connect"),
			jscProtocolStack("listTools"),
			jscProtocolStack("connect", SDK_WIN_FILE),
			jscProtocolStack("listTools", SDK_BUNDLED_FILE),
			// Awaited wrapper ancestors do not change the protocol frame.
			jscProtocolStack("listTools", SDK_FILE, [`getTools (${SDK_WRAPPER_FILE}:3:104)`, "async outer (/work/src/x.ts:4:34)"]),
			v8ProtocolStack("connect"),
			v8ProtocolStack("listTools"),
			v8ProtocolStack("listTools", [`Wf.getTools (file://${SDK_WRAPPER_FILE}:3:104)`, "async [eval]:4:23"]),
			stackWith([
				`y._setupTimeout (file://${SDK_FILE}:1:78)`,
				`y.request (file://${SDK_FILE}:1:169)`,
				`async y.connect (file://${SDK_FILE}:2:97)`,
			]),
		]) {
			expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(true);
			expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(false);
		}
	});

	it("matches callTool frames on the tool matcher only, in both formats and any SDK build path", () => {
		for (const stack of [
			jscProtocolStack("callTool", SDK_FILE, [`async callTool (${SDK_WRAPPER_FILE}:3:104)`]),
			jscProtocolStack("callTool", SDK_BUNDLED_FILE),
			jscProtocolStack("callTool", SDK_WIN_FILE),
			v8ProtocolStack("callTool", [`async Wf.callTool (file://${SDK_WRAPPER_FILE}:3:104)`]),
			stackWith([
				`y._setupTimeout (file://${SDK_FILE}:1:78)`,
				`y.request (file://${SDK_FILE}:1:169)`,
				`async y.callTool (file://${SDK_FILE}:2:267)`,
			]),
		]) {
			expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(true);
			expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(false);
		}
	});

	it("classifies by the method frame, whatever the class is called", () => {
		for (const className of ["y", "R11", "Client", "McpSdkClient", "Protocol"]) {
			const connectStack = stackWith([
				`${className}._setupTimeout (${SDK_FILE}:1:78)`,
				`${className}.request (${SDK_FILE}:1:169)`,
				`${className}.connect (${SDK_FILE}:2:97)`,
			]);
			const toolStack = connectStack.replace(".connect (", ".callTool (");

			expect(isCursorSdkMcpConnectTimeoutStack(connectStack)).toBe(true);
			expect(isCursorSdkMcpToolTimeoutStack(connectStack)).toBe(false);
			expect(isCursorSdkMcpToolTimeoutStack(toolStack)).toBe(true);
			expect(isCursorSdkMcpConnectTimeoutStack(toolStack)).toBe(false);
		}
	});

	it("does not match unknown methods or look-alike frame names", () => {
		const methods = ["listPrompts", "listResources", "ping", "reconnect", "connectTransport", "listToolsCached", "callToolStream", "recallTool", "Client"];
		for (const method of methods) {
			for (const stack of [jscProtocolStack(method), v8ProtocolStack(method)]) {
				expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(false);
				expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(false);
			}
		}
	});

	it("keeps an unknown request on the SDK default under connect, listTools or callTool ancestors", () => {
		const ancestors = [
			`async connect (${SDK_FILE}:2:97)`,
			`async listTools (${SDK_FILE}:2:173)`,
			`async callTool (${SDK_WRAPPER_FILE}:3:104)`,
			`async Wf.callTool (file://${SDK_WRAPPER_FILE}:3:104)`,
		];
		for (const stack of [jscProtocolStack("listPrompts", SDK_FILE, ancestors), v8ProtocolStack("listPrompts", ancestors)]) {
			expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(false);
			expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(false);
		}
	});

	it("lets the protocol method that issued the request win over its callers", () => {
		const connectUnderTool = jscProtocolStack("connect", SDK_FILE, [`async callTool (${SDK_WRAPPER_FILE}:3:104)`]);
		const toolUnderConnect = jscProtocolStack("callTool", SDK_FILE, [`async connect (${SDK_FILE}:2:97)`]);

		expect(isCursorSdkMcpConnectTimeoutStack(connectUnderTool)).toBe(true);
		expect(isCursorSdkMcpToolTimeoutStack(connectUnderTool)).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack(toolUnderConnect)).toBe(true);
		expect(isCursorSdkMcpConnectTimeoutStack(toolUnderConnect)).toBe(false);
	});

	it("requires the request and method frames themselves to be in the SDK", () => {
		const hostConnect = stackWith([
			`_setupTimeout (${SDK_FILE}:1:82)`,
			`request (${SDK_FILE}:1:187)`,
			`listPrompts (${SDK_FILE}:2:355)`,
			"connect (/work/src/mcp-host.ts:10:5)",
		]);
		const hostCallTool = hostConnect.replace("connect (/work/src", "callTool (/work/src");
		const nonSdkProtocol = jscProtocolStack("connect", "/work/src/vendored/458.js");
		const nonSdkMethod = stackWith([
			`_setupTimeout (${SDK_FILE}:1:82)`,
			`request (${SDK_FILE}:1:187)`,
			"connect (/work/src/mcp-host.ts:10:5)",
		]);
		const nonSdkRequest = stackWith([
			`_setupTimeout (${SDK_FILE}:1:82)`,
			"request (/work/src/mcp-host.ts:3:3)",
			`callTool (${SDK_FILE}:2:267)`,
		]);

		for (const stack of [hostConnect, nonSdkProtocol, nonSdkMethod]) {
			expect(isCursorSdkMcpConnectTimeoutStack(stack)).toBe(false);
		}
		for (const stack of [hostCallTool, nonSdkProtocol.replace("connect (", "callTool ("), nonSdkRequest]) {
			expect(isCursorSdkMcpToolTimeoutStack(stack)).toBe(false);
		}
		expect(isCursorSdkMcpConnectTimeoutStack(undefined)).toBe(false);
		expect(isCursorSdkMcpConnectTimeoutStack("")).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack(undefined)).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack("")).toBe(false);
	});

	it("requires the SDK's protocol timer frame even when SDK method frames are present", () => {
		const connectStack = stackWith([`request (${SDK_FILE}:1:187)`, `connect (${SDK_FILE}:2:97)`, `async setup (${SDK_FILE}:5:1)`]);
		const toolStack = connectStack.replace("connect (", "callTool (");
		const foreignTimer = stackWith([
			"_setupTimeout (/work/src/mcp-host.ts:1:1)",
			`request (${SDK_FILE}:1:187)`,
			`connect (${SDK_FILE}:2:97)`,
		]);

		expect(isCursorSdkMcpConnectTimeoutStack(connectStack)).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack(toolStack)).toBe(false);
		expect(isCursorSdkMcpConnectTimeoutStack(foreignTimer)).toBe(false);
		expect(isCursorSdkMcpToolTimeoutStack(foreignTimer.replace("connect (", "callTool ("))).toBe(false);
	});
});
