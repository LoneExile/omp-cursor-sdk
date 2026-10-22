import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	__testUtils,
	CURSOR_SDK_STARTUP_NOISE_PATTERNS,
	installCursorSdkProcessOutputFilter,
	isCursorSdkHookWarning,
	isCursorSdkStartupNoise,
} from "../src/cursor-sdk-output-filter.js";
import { CURSOR_SDK_BUILDS, CURSOR_SDK_ROOT, readCursorSdkBuildSource } from "./helpers/cursor-sdk-build-source.js";
import { loadInstalledSdkLogger } from "./helpers/cursor-sdk-installed-logger.js";
import { escapeRegExp } from "./helpers/cursor-sdk-minified-source.js";
import {
	COLORED_INFO_FRAME,
	PLAIN_INFO_FRAME,
	SAMPLE_INFO_CALL,
	SAMPLE_INFO_TIMESTAMP,
} from "./helpers/cursor-sdk-output-frames.js";
import { readInstalledPackageVersion } from "./helpers/installed-package.js";
import { captureProcessOutput, type ProcessOutputCapture } from "./helpers/process-output-capture.js";

// The filter acts on exact frames, so every template it matches is pinned to the installed SDK's own
// text, in every build the package ships: omp (Bun) loads `dist/bundled`, Node ESM `dist/esm`, CommonJS
// `dist/cjs`. An SDK upgrade that changes a template, adds a new variant of one, or adds a new log site of
// the same family fails here and forces a review instead of silently leaking noise or hiding a warning.

function distinctMatches(text: string, pattern: RegExp): string[] {
	return [...new Set(text.match(pattern) ?? [])].sort();
}

/**
 * Hook-logger warning templates in the SDK, `${...}` normalized to `${}`: every template literal handed to a
 * `.warn(` call that talks about hooks, plus the default hook logger's own `[hooks] ${}` wrapper.
 */
function hookWarningTemplates(bundle: string): string[] {
	const found = new Set<string>();
	for (const match of bundle.matchAll(/\.warn\(`((?:[^`\\]|\\.)*)`\)/g)) {
		const template = match[1]!.replace(/\$\{[^}]*\}/g, "${}");
		if (/matcher|Claude Code event|Tool "|symlink path|hooks|Hook/.test(template)) found.add(template);
	}
	return [...found].sort();
}

/**
 * What the filter does with each hook template: dropped as compatibility noise, or diverted as a warning that
 * carries information. `args` fill the `${}` placeholders of the SDK template in order.
 */
const HOOK_TEMPLATES: ReadonlyArray<{ template: string; args: readonly string[]; kind: "noise" | "hookWarning" | "wrapper" }> = [
	{ template: '${} trigger matcher "${}" is not supported in Cursor, hooks will fire for all triggers', args: ["SessionStart", "startup"], kind: "noise" },
	{ template: 'Claude Code event "${}" is not supported in Cursor and will be ignored', args: ["Notification"], kind: "noise" },
	{ template: 'Unknown Claude Code event "${}", skipping', args: ["FutureEvent"], kind: "noise" },
	{ template: 'All tools in matcher "${}" are unsupported, skipping hooks', args: ["Glob"], kind: "hookWarning" },
	{ template: 'Claude Code event "${}" has invalid value (expected array), skipping', args: ["SessionStart"], kind: "hookWarning" },
	{ template: "Refusing to load ${} config via symlink path: ${}", args: ["user", "/home/u/.cursor/hooks.json"], kind: "hookWarning" },
	{ template: "[hooks] Hook timeout of ${}s is very long (>1 hour)", args: ["7200"], kind: "hookWarning" },
	{ template: "[hooks] ${}", args: ["<message>"], kind: "wrapper" },
];
const HOOK_DEPRECATION =
	"[hooks] DEPRECATION WARNING: 'stop_hook_loop_limit' is deprecated. Use 'loop_limit' on individual hook scripts instead. The configured value is being ignored.";
const HOOK_TOOL_TEMPLATE = /`Tool "\$\{[\w$]+\}" is not supported in Cursor and will be ignored`/;

function instantiate(template: string, args: readonly string[]): string {
	let index = 0;
	return template.replace(/\$\{\}/g, () => args[index++]!);
}

describe("installed Cursor SDK output contract: package", () => {
	it("is the SDK version these templates were verified against", () => {
		expect(readInstalledPackageVersion("@cursor/sdk")).toBe("1.0.40");
	});

	it("loads the bundled build under Bun, which is the runtime omp uses", () => {
		const manifest = JSON.parse(readFileSync(join(CURSOR_SDK_ROOT, "package.json"), "utf8")) as {
			exports: Record<string, Record<string, string>>;
		};
		expect(manifest.exports["."]).toMatchObject({
			bun: "./dist/bundled/index.js",
			require: "./dist/cjs/index.js",
			import: "./dist/esm/index.js",
		});
	});
});

for (const build of CURSOR_SDK_BUILDS) {
	describe(`installed Cursor SDK ${build} build: bundle templates`, () => {
		let bundle: string;
		beforeAll(() => {
			bundle = readCursorSdkBuildSource(build);
		}, 30_000);

		for (const message of CURSOR_SDK_STARTUP_NOISE_PATTERNS) {
			it(`logs ${JSON.stringify(message)} as an INFO message argument`, () => {
				expect(bundle).toMatch(new RegExp(`\\.info\\([\\w$]+,"${escapeRegExp(message)}"`));
			});
		}

		it("has no other managed_skills.* or '<Service> load completed' message to review", () => {
			expect(distinctMatches(bundle, /managed_skills\.[a-z_]+/g)).toEqual(
				CURSOR_SDK_STARTUP_NOISE_PATTERNS.filter((message) => message.startsWith("managed_skills.")).sort(),
			);
			expect(distinctMatches(bundle, /[A-Za-z]+ load completed/g)).toEqual(
				CURSOR_SDK_STARTUP_NOISE_PATTERNS.filter((message) => message.endsWith(" load completed")).sort(),
			);
		});

		it("prints hook messages through the default hook logger as one console.warn string", () => {
			expect(bundle).toMatch(/warn:\(?[\w$]+\)?=>console\.warn\(`\[hooks\] \$\{[\w$]+\}`\)/);
		});

		it("emits the compatibility notices from the verified templates and value sets", () => {
			// Operand order differs per build: `"SessionStart"===t` (esm, cjs) vs `J==="SessionStart"` (bundled).
			expect(bundle).toMatch(/(?:"SessionStart"===[\w$]+|[\w$]+==="SessionStart")\|\|(?:"PreCompact"===[\w$]+|[\w$]+==="PreCompact")/);
			expect(bundle).toContain('["startup","resume","clear","compact"].includes(');
			expect(bundle).toContain('["manual","auto"].includes(');
			expect(bundle).toMatch(HOOK_TOOL_TEMPLATE);
			expect(bundle).toContain('=["Glob"]');
			expect(bundle).toContain('=["Notification","PermissionRequest"]');
		});

		it("has exactly the reviewed hook warning templates, each either filtered noise or a diverted warning", () => {
			expect(hookWarningTemplates(bundle)).toEqual(HOOK_TEMPLATES.map(({ template }) => template).sort());
			expect(bundle).toContain(`console.warn("${HOOK_DEPRECATION}")`);
			// Default hook logger + the timeout and deprecation sites: a new `[hooks]` site needs a decision.
			expect(bundle.split("[hooks]")).toHaveLength(4);
			expect(bundle).toMatch(/console\.warn\(`\[hooks\] Hook timeout of \$\{[\w$.]+\}s is very long \(>1 hour\)`\)/);
		});

		it("classifies every hook template instance the way the contract says", () => {
			for (const { template, args, kind } of HOOK_TEMPLATES) {
				if (kind === "wrapper") continue;
				// Templates passed to the default hook logger arrive prefixed; the direct console.warn sites carry the prefix.
				const frame = template.startsWith("[hooks] ") ? instantiate(template, args) : `[hooks] ${instantiate(template, args)}`;
				expect({ frame, noise: isCursorSdkStartupNoise(frame), warning: isCursorSdkHookWarning(frame) }).toEqual({
					frame,
					noise: kind === "noise",
					warning: kind === "hookWarning",
				});
			}
			expect(isCursorSdkHookWarning(HOOK_DEPRECATION)).toBe(true);
			expect(isCursorSdkStartupNoise(HOOK_DEPRECATION)).toBe(false);
			expect(isCursorSdkStartupNoise('[hooks] Tool "Glob" is not supported in Cursor and will be ignored')).toBe(true);
		});

		it("reports ignore-mapping failures as console.error(template, error) caused by an unconfigured ripgrep path", () => {
			expect(bundle.split("Error initializing ignore mapping for")).toHaveLength(2);
			expect(bundle).toMatch(/console\.error\(`Error initializing ignore mapping for \$\{[\w$]+\}:`,[\w$]+\)/);
			expect(bundle.split("Ripgrep path not configured")).toHaveLength(2);
			// `throw new Error(` in the esm/cjs builds, `throw Error(` in the bundled build.
			expect(bundle).toMatch(/throw (?:new )?Error\("Ripgrep path not configured\. Call configureRipgrepPath\(\) at startup\."\)/);
		});
	});

	describe(`installed Cursor SDK ${build} build: printed frames`, () => {
		let capture: ProcessOutputCapture | undefined;

		// A lease left by another suite would make the installs below no-ops.
		beforeEach(() => {
			__testUtils.resetProcessOutputFilter();
		});
		afterEach(() => {
			__testUtils.resetProcessOutputFilter();
			capture?.restore();
			capture = undefined;
		});

		function printFrames(useColors: boolean): string[] {
			// The printer decides colors when it is created and looks console up at call time: create it fresh,
			// before the filter exists, and record what it prints.
			const logger = loadInstalledSdkLogger(build, useColors);
			capture = captureProcessOutput();
			const frames: string[] = [];
			for (const message of CURSOR_SDK_STARTUP_NOISE_PATTERNS) {
				for (const ctx of [undefined, SAMPLE_INFO_CALL.ctx]) {
					for (const metadata of [
						undefined,
						SAMPLE_INFO_CALL.metadata,
						{ skills_on_disk: [{ skill_id: "cursor", has_skill_md: true, last_synced_at: null }], manifest_present: true },
					]) {
						logger.info(logger.context(ctx), message, metadata);
					}
				}
			}
			for (const call of capture.consoleCalls) {
				// One complete string per log call, on console.log: the unit the filter matches.
				expect(call.method).toBe("log");
				expect(call.args).toHaveLength(1);
				expect(typeof call.args[0]).toBe("string");
				frames.push(call.args[0] as string);
			}
			capture.clear();
			return frames;
		}

		it("reproduces the frame samples the behavior tests use", () => {
			for (const [useColors, sample] of [
				[false, PLAIN_INFO_FRAME],
				[true, COLORED_INFO_FRAME],
			] as const) {
				const logger = loadInstalledSdkLogger(build, useColors);
				capture = captureProcessOutput();
				logger.info(logger.context(SAMPLE_INFO_CALL.ctx), SAMPLE_INFO_CALL.message, SAMPLE_INFO_CALL.metadata);
				const printed = capture.consoleCalls[0]!.args[0] as string;
				expect(printed.replace(/\d{2}:\d{2}:\d{2}\.\d{3}/, SAMPLE_INFO_TIMESTAMP)).toBe(sample);
				expect(printed.includes("\u001b[")).toBe(useColors);
				capture.restore();
				capture = undefined;
			}
		});

		for (const useColors of [false, true]) {
			it(`prints every filtered INFO message as a frame the filter recognizes and drops (colors=${useColors})`, () => {
				const frames = printFrames(useColors);
				expect(frames).toHaveLength(CURSOR_SDK_STARTUP_NOISE_PATTERNS.length * 6);
				expect(frames.filter((frame) => !isCursorSdkStartupNoise(frame))).toEqual([]);
				expect(frames.filter((frame) => !isCursorSdkStartupNoise(`${frame}\n`))).toEqual([]);

				// Re-emit the same frames on every channel Node/Bun/omp can route them through.
				installCursorSdkProcessOutputFilter();
				const logger = loadInstalledSdkLogger(build, useColors);
				for (const message of CURSOR_SDK_STARTUP_NOISE_PATTERNS) logger.info(logger.context("syncBuiltinSkills"), message, { skill_id: "clone" });
				for (const frame of frames) {
					process.stdout.write(`${frame}\n`);
					process.stderr.write(`${frame}\n`);
				}
				expect(capture!.consoleCalls).toEqual([]);
				expect(capture!.stdout).toEqual([]);
				expect(capture!.stderr).toEqual([]);
			});
		}

		it("keeps warnings with a filtered message, and unrelated INFO frames, visible", () => {
			const logger = loadInstalledSdkLogger(build, false);
			capture = captureProcessOutput();
			installCursorSdkProcessOutputFilter();
			const ctx = logger.context("loadRules");
			logger.warn(ctx, CURSOR_SDK_STARTUP_NOISE_PATTERNS[3]!, { reason: "failed" });
			logger.info(ctx, "SomeOtherService load completed");
			logger.info(ctx, "managed_skills.something_new");
			expect(capture.consoleCalls.map((call) => call.method)).toEqual(["warn", "log", "log"]);
			const warning = capture.consoleCalls[0]!.args[0] as string;
			expect(warning).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} WARN  LocalCursorRulesService load completed /);
			expect(capture.stdout).toHaveLength(0);
		});
	});
}
