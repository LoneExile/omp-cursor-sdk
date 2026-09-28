import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "@cursor/sdk";

export const CURSOR_MAX_MODE_PATCH_MARKER = "/* omp-cursor-sdk:max-mode-patch */";
export const CURSOR_MAX_MODE_PARAM = { id: "max_mode", value: "true" } as const;
export const CURSOR_SDK_MAX_MODE_BUILD_FILES = [
	"dist/esm/34.js",
	"dist/cjs/342.js",
	"dist/bundled/index.js",
] as const;

export function applyCursorMaxModeSelection(selection: ModelSelection, enabled: boolean): ModelSelection {
	if (!enabled) return selection;
	const params = selection.params ?? [];
	if (params.some((param) => param.id === CURSOR_MAX_MODE_PARAM.id && param.value === CURSOR_MAX_MODE_PARAM.value)) {
		return selection;
	}
	return { ...selection, params: [...params, { ...CURSOR_MAX_MODE_PARAM }] };
}

export function cursorSdkPackageRootFromResolved(resolvedSpecifier: string): string {
	const filePath = resolvedSpecifier.startsWith("file:") ? fileURLToPath(resolvedSpecifier) : resolvedSpecifier;
	let dir = dirname(filePath);
	for (let depth = 0; depth < 8; depth += 1) {
		const packagePath = join(dir, "package.json");
		if (existsSync(packagePath)) {
			try {
				const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
				if (parsed.name === "@cursor/sdk") return dir;
			} catch {
				// Keep walking; a non-package.json along the path is not the SDK root.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`Cursor Max Mode is enabled, but ${resolvedSpecifier} is not inside an @cursor/sdk package. Run \`npm run patch:cursor-sdk\` against the SDK this process imports.`,
	);
}

export function missingCursorSdkMaxModePatchFiles(packageRoot: string): string[] {
	const existing = CURSOR_SDK_MAX_MODE_BUILD_FILES.filter((rel) => existsSync(join(packageRoot, rel)));
	if (existing.length === 0) return [...CURSOR_SDK_MAX_MODE_BUILD_FILES];
	return existing.filter((rel) => !readFileSync(join(packageRoot, rel), "utf8").includes(CURSOR_MAX_MODE_PATCH_MARKER));
}

export function staleCursorSdkMaxModePatchFiles(packageRoot: string, processStartedAtMs: number): string[] {
	return CURSOR_SDK_MAX_MODE_BUILD_FILES.filter((rel) => {
		const path = join(packageRoot, rel);
		if (!existsSync(path)) return false;
		try {
			return statSync(path).mtimeMs > processStartedAtMs;
		} catch {
			return false;
		}
	});
}

export function assertCursorSdkMaxModePatched(
	resolvedSpecifier: string,
	options: { processStartedAtMs?: number } = {},
): void {
	const packageRoot = cursorSdkPackageRootFromResolved(resolvedSpecifier);
	const missing = missingCursorSdkMaxModePatchFiles(packageRoot);
	if (missing.length === 0) {
		const stale = staleCursorSdkMaxModePatchFiles(
			packageRoot,
			// A build file patched after this process started is not the module this process loaded.
			options.processStartedAtMs ?? Date.now() - Math.round(process.uptime() * 1000),
		);
		if (stale.length === 0) return;
		throw new Error(
			`Cursor Max Mode is enabled, but the resolved @cursor/sdk at ${resolvedSpecifier} was patched after this process started (${stale.join(", ")}; package ${packageRoot}). Restart omp so the patched SDK is loaded, then send the turn again.`,
		);
	}
	throw new Error(
		`Cursor Max Mode is enabled, but the resolved @cursor/sdk at ${resolvedSpecifier} is not patched (package ${packageRoot}; missing marker in ${missing.join(", ")}). Run \`npm run patch:cursor-sdk\` from the omp-cursor-sdk checkout, or \`node scripts/patch-cursor-sdk.mjs --sdk ${packageRoot}\`. Re-apply the patch after \`omp plugin install\` or reinstall.`,
	);
}

export function assertImportedCursorSdkMaxModePatched(): void {
	const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string };
	if (typeof meta.resolve !== "function") {
		throw new Error(
			"Cursor Max Mode is enabled, but import.meta.resolve is unavailable, so the @cursor/sdk patch could not be verified. Run `npm run patch:cursor-sdk` and use a runtime that supports import.meta.resolve.",
		);
	}
	assertCursorSdkMaxModePatched(meta.resolve("@cursor/sdk"));
}
