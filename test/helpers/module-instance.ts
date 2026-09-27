import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The part of Bun's runtime plugin API used here (the test tsconfig has no Bun types). */
interface BunRuntimePlugins {
	plugin(plugin: {
		name: string;
		setup(build: {
			onLoad(
				options: { filter: RegExp; namespace?: string },
				callback: (args: { path: string }) => Promise<{ contents: string; loader: "ts" | "js" }>,
			): void;
		}): void;
	}): void;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let installed = false;

/**
 * Import a repo module as part of a separate module graph, the way omp loads the plugin
 * for an isolated subagent or an ACP session: legacy-pi-compat.ts loadLegacyPiModule
 * imports the entry with a fresh `?mtime=` tag and rewriteLegacyExtensionSource adds that
 * tag to every relative import, so the whole graph, module state included, is evaluated
 * again. Here the tag is `?instance=<n>`.
 */
export async function importModuleInstance<T>(repoPath: string, instance: number): Promise<T> {
	installInstanceLoader();
	return (await import(`${join(REPO_ROOT, repoPath)}?instance=${instance}`)) as T;
}

function installInstanceLoader(): void {
	if (installed) return;
	installed = true;
	const root = REPO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	(globalThis as unknown as { Bun: BunRuntimePlugins }).Bun.plugin({
		name: "omp-cursor-sdk-test-module-instance",
		setup(build) {
			build.onLoad({ filter: new RegExp(`^${root}/(?:src|shared)/.*\\?instance=\\d+$`), namespace: "file" }, async (args) => {
				const [path, query] = args.path.split("?");
				const source = await readFile(path, "utf8");
				const contents = source.replace(/((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\2/g, `$1$2$3?${query}$2`);
				return { contents, loader: path.endsWith(".ts") ? "ts" : "js" };
			});
		},
	});
}
