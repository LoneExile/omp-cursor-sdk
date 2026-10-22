#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_ATTRIBUTION_MARKER = "/* omp-cursor-sdk:commit-attribution-patch */";
// @cursor/sdk's local executor never sets attributionConfigProvider (no public option reaches it
// through 1.0.40). The request context then uses `attributeCommitsToAgent ?? true`, so every
// local commit gets `Co-authored-by: Cursor <cursoragent@cursor.com>`.
// `??!1` is the false default. An explicit provider value still wins.
const COMMIT_ATTRIBUTION_FROM = "attributeCommitsToAgent??!0";
const COMMIT_ATTRIBUTION_TO = `attributeCommitsToAgent??!1${COMMIT_ATTRIBUTION_MARKER}`;

// The anchor lives in one chunk of every build, and the chunk name changes between SDK releases
// (esm/cjs `479.js` in 1.0.34, `331.js` in 1.0.40; the Bun build is the single `dist/bundled/index.js`).
// Each build is searched by content instead of by file name.
export const TARGETS = ["dist/esm", "dist/cjs", "dist/bundled"].map((build) => ({
	build,
	from: COMMIT_ATTRIBUTION_FROM,
	to: COMMIT_ATTRIBUTION_TO,
	marker: COMMIT_ATTRIBUTION_MARKER,
}));

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

Patches @cursor/sdk so local agents do not add
Co-authored-by: Cursor <cursoragent@cursor.com> to commits unless an attribution provider
explicitly enables it. The SDK's local executor does not set that provider and does not read
~/.cursor/cli-config.json, so the commit-attribution default (on) is changed to off.
Cloud agents still add the trailer.
The anchor is found by content in dist/esm, dist/cjs and dist/bundled (the build Bun loads);
a build directory that exists but has no anchor fails.
The patch is optional: omp-cursor-sdk sends turns without it. Default SDK: this repo's
node_modules/@cursor/sdk.
--check reports without writing and exits 1 unless every build is patched.
--sdk may be repeated. --all also patches ~/.omp/plugins/node_modules/@cursor/sdk when it exists.
Re-apply after omp plugin install or a dependency reinstall, then restart omp.
Cursor Max Mode needs no patch: @cursor/sdk sends it natively (ModelSelection.maxMode).`);
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

function listJsFiles(root, prefix = "") {
	const files = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) files.push(...listJsFiles(root, rel));
		else if (entry.isFile() && entry.name.endsWith(".js")) files.push(rel);
	}
	return files.sort();
}

// A build is patchable when exactly one of its files holds exactly one anchor, and patched when
// exactly one file holds exactly one patched expression and its marker. Anything else is drift:
// the SDK moved or duplicated the code the patch targets.
function inspectBuild(sdkRoot, target) {
	const buildRoot = join(sdkRoot, target.build);
	if (!existsSync(buildRoot)) return { build: target.build, status: "absent" };
	const sites = [];
	for (const rel of listJsFiles(buildRoot)) {
		const path = join(buildRoot, rel);
		const text = readFileSync(path, "utf8");
		const site = {
			file: `${target.build}/${rel}`,
			path,
			anchor: count(text, target.from),
			patched: count(text, target.to),
			marker: count(text, target.marker),
		};
		if (site.anchor + site.patched + site.marker > 0) sites.push(site);
	}
	const [site] = sites;
	if (sites.length === 1 && site.patched === 1 && site.anchor === 0 && site.marker === 1) {
		return { build: target.build, status: "patched", file: site.file };
	}
	if (sites.length === 1 && site.anchor === 1 && site.patched === 0 && site.marker === 0) {
		return { build: target.build, status: "unpatched", file: site.file, path: site.path, target };
	}
	const found =
		sites.length === 0
			? `no file under ${target.build} contains ${target.from} or ${target.marker}`
			: sites.map((entry) => `${entry.file} anchor=${entry.anchor} patched=${entry.patched} marker=${entry.marker}`).join("; ");
	return {
		build: target.build,
		status: "drifted",
		detail: `expected exactly one file with one unpatched anchor ${target.from} or one patched expression with ${target.marker}; found ${found}`,
	};
}

function patchSdk(sdkRoot, check) {
	const resolved = isAbsolute(sdkRoot) ? sdkRoot : resolve(sdkRoot);
	if (!existsSync(resolved)) {
		fail(`${resolved} does not exist`);
		return false;
	}
	const reports = TARGETS.map((target) => inspectBuild(resolved, target));
	if (reports.every((report) => report.status === "absent")) {
		fail(`${resolved} has none of ${TARGETS.map((target) => target.build).join(", ")}`);
		return false;
	}
	let ok = true;
	for (const report of reports) {
		if (report.status === "absent") {
			console.log(`${resolved}: ${report.build}: absent`);
			continue;
		}
		if (report.status === "patched") {
			console.log(`${resolved}: ${report.file}: patched`);
			continue;
		}
		if (report.status === "drifted") {
			fail(`${resolved}: ${report.build}: ${report.detail}`);
			console.log(`${resolved}: ${report.build}: drifted`);
			ok = false;
			continue;
		}
		if (check) {
			console.log(`${resolved}: ${report.file}: unpatched`);
			ok = false;
			continue;
		}
		const { from, to, marker } = report.target;
		const current = readFileSync(report.path, "utf8");
		const next = current.replace(from, () => to);
		if (next === current || count(next, to) !== 1 || count(next, from) !== 0) {
			fail(`${report.path}: replacement did not produce one ${marker} expression`);
			ok = false;
			continue;
		}
		writeFileSync(report.path, next);
		console.log(`${resolved}: ${report.file}: patched`);
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
