import { ensureCursorTreeSitterVendorDir } from "./cursor-ripgrep-path.js";
import { installCursorSdkProcessOutputFilter } from "./cursor-sdk-output-filter.js";

export type CursorSdkModule = typeof import("@cursor/sdk");

/**
 * Every runtime load of the SDK goes through here (`test/cursor-sdk-lazy-import.test.ts` bans any
 * other runtime `@cursor/sdk` import), so this is where the process is prepared for the SDK before it
 * first evaluates:
 *
 * - the process-lifetime SDK output filter lease is taken, so SDK bootstrap and background work
 *   (rules/skills loads, watchers) that log outside a provider turn are filtered from the first load
 *   on;
 * - the native shell-parser lookup is pointed at the installed platform package, which the SDK's own
 *   search cannot find from a compiled binary.
 *
 * Both calls are idempotent and cheap once done.
 */
export async function loadCursorSdk(): Promise<CursorSdkModule> {
	installCursorSdkProcessOutputFilter();
	ensureCursorTreeSitterVendorDir();
	return import("@cursor/sdk");
}
