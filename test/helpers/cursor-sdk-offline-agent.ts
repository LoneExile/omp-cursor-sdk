import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelListItem, ModelSelection, ToolName } from "@cursor/sdk";
import { cursorSdkBuildEntry, type CursorSdkBuild } from "./cursor-sdk-build-source.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cursor-sdk-offline-agent-child.mjs");
const nodeAvailable = spawnSync("node", ["--version"], { stdio: "ignore" }).status === 0;

/** The `Agent.create` options a case may set; the child adds the API key and a throwaway local cwd. */
export interface OfflineAgentCase {
	model?: ModelSelection;
	tools?: ToolName[];
}

export type OfflineAgentResult = { model: ModelSelection | null } | { error: string };

/** The runtime that loads `build` (Bun loads the bundled build, Node the esm and cjs builds), or undefined when it is not available. */
export function offlineAgentRuntime(build: CursorSdkBuild): string | undefined {
	if (build === "bundled") return process.versions.bun ? process.execPath : undefined;
	return nodeAvailable ? "node" : undefined;
}

/**
 * Create a local agent for each case inside the real SDK `build`, in a child process with its own HOME
 * (the SDK state root lives there) and, when `catalog` is given, the SDK's own offline model catalog.
 */
export function createAgentsInBuild(
	build: CursorSdkBuild,
	cases: Record<string, OfflineAgentCase>,
	catalog?: ModelListItem[],
): Record<string, OfflineAgentResult> {
	const runtime = offlineAgentRuntime(build);
	if (runtime === undefined) throw new Error(`no runtime can load the ${build} build`);
	const home = mkdtempSync(join(tmpdir(), "cursor-sdk-offline-agent-home-"));
	try {
		const result = spawnSync(runtime, [CHILD, cursorSdkBuildEntry(build), JSON.stringify(cases)], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				...(catalog ? { CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: JSON.stringify({ items: catalog }) } : {}),
			},
			encoding: "utf8",
			timeout: 60_000,
		});
		if (result.status !== 0) throw new Error(`the ${build} child exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
		const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
		if (!line) throw new Error(`the ${build} child printed no result:\n${result.stdout}\n${result.stderr}`);
		return JSON.parse(line.slice("RESULT:".length)) as Record<string, OfflineAgentResult>;
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}
