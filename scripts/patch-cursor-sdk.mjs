#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "/* omp-cursor-sdk:max-mode-patch */";

export const TARGETS = [
	{
		rel: "dist/esm/479.js",
		from: "new nx.G4({modelId:t.model.id,parameters:(t.model.params??[]).map((e=>new nx.SR({id:e.id,value:e.value})))})",
		to: `new nx.G4({modelId:t.model.id,maxMode:(t.model.params??[]).some((e=>e.id==="max_mode"&&e.value==="true"))${MARKER},parameters:(t.model.params??[]).filter((e=>!(e.id==="max_mode"&&e.value==="true"))).map((e=>new nx.SR({id:e.id,value:e.value})))})`,
	},
	{
		rel: "dist/cjs/479.js",
		from: "new ax.G4({modelId:t.model.id,parameters:(t.model.params??[]).map((e=>new ax.SR({id:e.id,value:e.value})))})",
		to: `new ax.G4({modelId:t.model.id,maxMode:(t.model.params??[]).some((e=>e.id==="max_mode"&&e.value==="true"))${MARKER},parameters:(t.model.params??[]).filter((e=>!(e.id==="max_mode"&&e.value==="true"))).map((e=>new ax.SR({id:e.id,value:e.value})))})`,
	},
	{
		rel: "dist/bundled/index.js",
		from: "new r5({modelId:m.model.id,parameters:(m.model.params??[]).map((W1)=>new j$({id:W1.id,value:W1.value}))})",
		to: `new r5({modelId:m.model.id,maxMode:(m.model.params??[]).some((W1)=>W1.id==="max_mode"&&W1.value==="true")${MARKER},parameters:(m.model.params??[]).filter((W1)=>!(W1.id==="max_mode"&&W1.value==="true")).map((W1)=>new j$({id:W1.id,value:W1.value}))})`,
	},
];

function defaultSdkPath() {
	return fileURLToPath(new URL("../node_modules/@cursor/sdk", import.meta.url));
}

function hoistedSdkPath() {
	return join(homedir(), ".omp", "plugins", "node_modules", "@cursor/sdk");
}

function fail(message) {
	console.error(`patch-cursor-sdk: ${message}`);
	process.exitCode = 1;
}

function printHelp() {
	console.log(`Usage: node scripts/patch-cursor-sdk.mjs [--check] [--sdk <path>]... [--all]

Patches @cursor/sdk so a model param {id:"max_mode", value:"true"} sets RequestedModel.maxMode
and is not forwarded as a parameter. Default SDK: this repo's node_modules/@cursor/sdk.
--sdk may be repeated. --all also patches ~/.omp/plugins/node_modules/@cursor/sdk when it exists.
Re-apply after omp plugin install or a dependency reinstall. Max Mode bills higher; leave it off
unless you want the long-context window.`);
}

function parseArgs(argv) {
	const sdk = [];
	let check = false;
	let all = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--check") {
			check = true;
			continue;
		}
		if (arg === "--all") {
			all = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") return { help: true, check, all, sdk };
		if (arg === "--sdk") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) {
				fail("--sdk requires a path");
				return { error: true, check, all, sdk };
			}
			sdk.push(value);
			i += 1;
			continue;
		}
		fail(`unknown argument ${arg}`);
		return { error: true, check, all, sdk };
	}
	return { help: false, error: false, check, all, sdk };
}

function count(text, needle) {
	let found = 0;
	let index = 0;
	while (index >= 0) {
		index = text.indexOf(needle, index);
		if (index < 0) break;
		found += 1;
		index += needle.length;
	}
	return found;
}

function inspectFile(sdkRoot, target) {
	const path = join(sdkRoot, target.rel);
	if (!existsSync(path)) return { rel: target.rel, status: "absent" };
	const text = readFileSync(path, "utf8");
	const patched = count(text, target.to);
	const anchor = count(text, target.from);
	const marker = count(text, MARKER);
	if (patched === 1 && anchor === 0 && marker === 1) return { rel: target.rel, status: "patched", path, text };
	if (anchor === 1 && patched === 0 && marker === 0) return { rel: target.rel, status: "unpatched", path, text, target };
	return {
		rel: target.rel,
		status: "drifted",
		path,
		detail: `expected exactly one unpatched anchor or one patched expression with ${MARKER}; found anchor=${anchor} patched=${patched} marker=${marker}`,
	};
}

function patchSdk(sdkRoot, check) {
	const resolved = isAbsolute(sdkRoot) ? sdkRoot : resolve(sdkRoot);
	if (!existsSync(resolved)) {
		fail(`${resolved} does not exist`);
		return false;
	}
	const reports = TARGETS.map((target) => inspectFile(resolved, target));
	const existing = reports.filter((report) => report.status !== "absent");
	if (existing.length === 0) {
		fail(`${resolved} has none of ${TARGETS.map((target) => target.rel).join(", ")}`);
		return false;
	}
	let ok = true;
	for (const report of reports) {
		if (report.status === "absent") {
			console.log(`${resolved}: ${report.rel}: absent`);
			continue;
		}
		if (report.status === "patched") {
			console.log(`${resolved}: ${report.rel}: patched`);
			continue;
		}
		if (report.status === "drifted") {
			fail(`${report.path}: ${report.detail}`);
			console.log(`${resolved}: ${report.rel}: drifted`);
			ok = false;
			continue;
		}
		if (check) {
			console.log(`${resolved}: ${report.rel}: unpatched`);
			ok = false;
			continue;
		}
		const next = report.text.replace(report.target.from, report.target.to);
		if (next === report.text || count(next, report.target.to) !== 1) {
			fail(`${report.path}: replacement did not produce the Max Mode expression`);
			ok = false;
			continue;
		}
		writeFileSync(report.path, next);
		console.log(`${resolved}: ${report.rel}: patched`);
	}
	return ok;
}

function sdkRoots(args) {
	const roots = args.sdk.length > 0 ? [...args.sdk] : [defaultSdkPath()];
	if (args.all) {
		const extras = [defaultSdkPath(), hoistedSdkPath()];
		for (const extra of extras) {
			if (!roots.includes(extra) && existsSync(extra)) roots.push(extra);
		}
		if (!existsSync(hoistedSdkPath())) {
			console.log(`${hoistedSdkPath()}: absent`);
		}
	}
	return roots;
}

// process.argv[1] keeps symlinks, and so does import.meta.url under --preserve-symlinks-main, while
// Node resolves them in import.meta.url otherwise; compare real paths on both sides, because a
// mismatch makes a run through a symlinked directory (macOS /tmp) do nothing and exit 0.
function startedDirectly() {
	if (process.argv[1] === undefined) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
	} catch {
		return false;
	}
}

const invokedDirectly = startedDirectly();
if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
	} else if (!args.error) {
		let ok = true;
		for (const root of sdkRoots(args)) {
			if (!patchSdk(root, args.check)) ok = false;
		}
		if (!ok) process.exitCode = 1;
	}
}
