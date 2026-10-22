// Runs in a fresh `bun` process (spawned by test/cursor-tree-sitter-vendor-dir.test.ts) so that
// `loadCursorSdk()` loads `@cursor/sdk` for the first time, with no module state from a test worker.
// Prints one `RESULT:<json>` line.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CursorSdkRuntime from "../../src/cursor-sdk-runtime.js";
import { installedCursorSdkEsmEntry, loadInstalledCursorParsers } from "./cursor-native-parser.js";

/** The part of Bun's runtime plugin API used here (the test tsconfig has no Bun types). */
interface BunRuntimePlugins {
	plugin(plugin: {
		name: string;
		setup(build: {
			module(specifier: string, callback: () => { exports: Record<string, unknown>; loader: "object" }): void;
		}): void;
	}): void;
}

interface NativeParser {
	setLanguage(language: unknown): void;
	parse(source: string): { rootNode: { type: string; hasError: boolean; toString(): string } };
}

const runtimeModule = new URL("../../src/cursor-sdk-runtime.ts", import.meta.url).href;

// Dynamic on purpose: the observer plugin must be registered, and argv[1] moved, before the runtime
// module (and through it the SDK) is first imported.
async function importRuntime(): Promise<typeof CursorSdkRuntime> {
	return (await import(runtimeModule)) as typeof CursorSdkRuntime;
}

/**
 * Replace `@cursor/sdk` with a module that records, while it is being evaluated (which is when the
 * real SDK first runs), `CURSOR_TREE_SITTER_VENDOR_DIR` and whether the process output filter is
 * installed. Bun evaluates a plugin module at its first import, so the recorded values are what the
 * SDK would see on its first load. Also records the filter state after importing the runtime module
 * (before the load) and after the load.
 */
async function observeProcessAtSdkEvaluation(): Promise<{
	observedVendorDir: string | null;
	outputFilterAtImport: boolean;
	outputFilterAtEvaluation: boolean;
	outputFilterAfterLoad: boolean;
}> {
	const unwrappedStdoutWrite = process.stdout.write;
	const outputFilterInstalled = () => process.stdout.write !== unwrappedStdoutWrite;
	const bun = (globalThis as unknown as { Bun: BunRuntimePlugins }).Bun;
	bun.plugin({
		name: "observe-cursor-sdk-evaluation",
		setup(build) {
			build.module("@cursor/sdk", () => ({
				exports: {
					observedVendorDir: process.env.CURSOR_TREE_SITTER_VENDOR_DIR ?? null,
					outputFilterAtEvaluation: outputFilterInstalled(),
				},
				loader: "object",
			}));
		},
	});
	const { loadCursorSdk } = await importRuntime();
	const outputFilterAtImport = outputFilterInstalled();
	const sdk = (await loadCursorSdk()) as unknown as {
		observedVendorDir: string | null;
		outputFilterAtEvaluation: boolean;
	};
	return {
		observedVendorDir: sdk.observedVendorDir,
		outputFilterAtImport,
		outputFilterAtEvaluation: sdk.outputFilterAtEvaluation,
		outputFilterAfterLoad: outputFilterInstalled(),
	};
}

/**
 * Load the real SDK, launched from a directory that neither the SDK's `process.argv[1]` search nor its
 * executable search can reach (the compiled `omp` binary and a plugin installed beside it), and ask the
 * SDK's own vendored loader, then a real parse, whether the native Bash parser is usable.
 */
async function nativeBashParsingAfterLoad() {
	const launcherDir = mkdtempSync(join(tmpdir(), "omp-launcher-"));
	try {
		process.argv[1] = join(launcherDir, "cli.js");
		const sdkEsmEntry = installedCursorSdkEsmEntry(import.meta.url);
		const before = loadInstalledCursorParsers(sdkEsmEntry).map((load) => load.available);
		const { loadCursorSdk } = await importRuntime();
		await loadCursorSdk();
		const [parserLoad, bashLoad] = loadInstalledCursorParsers(sdkEsmEntry);
		const after = [parserLoad!.available, bashLoad!.available];
		if (!parserLoad!.available || !bashLoad!.available) return { before, after };

		const parser = new (parserLoad.module as new () => NativeParser)();
		parser.setLanguage(bashLoad.module);
		const { rootNode } = parser.parse("printf '%s\\n' hello | cat > output.txt");
		return {
			before,
			after,
			root: { type: rootNode.type, hasError: rootNode.hasError, tree: rootNode.toString() },
		};
	} finally {
		rmSync(launcherDir, { recursive: true, force: true });
	}
}

const modes = {
	"observe-sdk-evaluation": observeProcessAtSdkEvaluation,
	"native-bash-parsing": nativeBashParsingAfterLoad,
} as const;

const mode = process.argv[2] as keyof typeof modes;
const result = await modes[mode]();
process.stdout.write(`\nRESULT:${JSON.stringify(result)}\n`);
