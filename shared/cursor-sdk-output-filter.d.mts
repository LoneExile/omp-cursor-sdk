/** Exact INFO messages of verified SDK startup/reload log frames. */
export declare const CURSOR_SDK_STARTUP_NOISE_PATTERNS: readonly string[];
export interface CursorSdkProcessOutputFilterOptions {
	/** Receives each verified SDK `[hooks]` warning (no line ending, no colors) instead of the terminal. */
	divertHookWarning?: (message: string) => void;
}
export declare function isCursorSdkOutputSuppressed(): boolean;
export declare function suppressCursorSdkOutput<T>(operation: () => T): T;
/** True when `text` is exactly one complete verified SDK noise frame. */
export declare function isCursorSdkStartupNoise(text: string): boolean;
/** True when `text` is exactly one complete verified SDK `[hooks]` warning frame. */
export declare function isCursorSdkHookWarning(text: string): boolean;
export declare function installCursorSdkOutputFilter(): () => void;
export declare function installCursorSdkProcessOutputFilter(options?: CursorSdkProcessOutputFilterOptions): void;
export declare const __testUtils: { resetProcessOutputFilter(): void };
