import { logger } from "@oh-my-pi/pi-utils";
import { installCursorSdkProcessOutputFilter as installSharedProcessOutputFilter } from "../shared/cursor-sdk-output-filter.mjs";

export {
	__testUtils,
	CURSOR_SDK_STARTUP_NOISE_PATTERNS,
	isCursorSdkHookWarning,
	isCursorSdkOutputSuppressed,
	isCursorSdkStartupNoise,
	suppressCursorSdkOutput,
} from "../shared/cursor-sdk-output-filter.mjs";

/**
 * Takes the process-lifetime SDK output filter lease (idempotent). SDK `[hooks]` warnings that carry
 * information (timeout, deprecation, refused symlink path, ...) go to omp's file logger: omp's TUI owns
 * the terminal, so printing them raw would corrupt the screen, and they are not model-visible state.
 */
export function installCursorSdkProcessOutputFilter(): void {
	installSharedProcessOutputFilter({
		divertHookWarning: (message) => logger.warn(message, { origin: "@cursor/sdk" }),
	});
}
