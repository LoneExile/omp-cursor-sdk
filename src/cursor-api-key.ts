export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

import { resolveApiKeyOnce, type ApiKey } from "@oh-my-pi/pi-ai";

// Non-secret literal sentinel for pi's provider registry. Pi 0.77 treats `$ENV_VAR`
// values as unconfigured when the env var is absent, which hides fallback models
// before `/login`. Keep the provider available and resolve the real key in the
// Cursor provider turn path from pi auth or CURSOR_API_KEY.
export const CURSOR_API_KEY_CONFIG_VALUE = "omp-cursor-sdk-cursor-api-key-placeholder";

const CURSOR_API_KEY_PLACEHOLDERS = new Set([
	CURSOR_API_KEY_ENV_VAR,
	`$${CURSOR_API_KEY_ENV_VAR}`,
	`\${${CURSOR_API_KEY_ENV_VAR}}`,
	CURSOR_API_KEY_CONFIG_VALUE,
	// Legacy placeholder written into configs by earlier port versions.
	"pi-cursor-sdk-cursor-api-key-placeholder",
]);

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (CURSOR_API_KEY_PLACEHOLDERS.has(trimmed)) return process.env.CURSOR_API_KEY?.trim() || undefined;
	return trimmed;
}

/**
 * Resolve an ApiKey that may be a resolver to the literal string the Cursor
 * SDK needs. OMP can hand providers a static string or an ApiKeyResolver
 * (minting/rotation); discarding the resolver would surface a false
 * "missing API key". Uses OMP's own initial-resolve helper.
 */
export async function resolveCursorStringApiKey(apiKey: ApiKey | undefined): Promise<string | undefined> {
	return resolveCursorApiKey(await resolveApiKeyOnce(apiKey));
}

/**
 * Sync narrowing for key-adjacent paths that only use the key for scrubbing
 * or as a fallback (the primary resolution is requireCursorApiKey). A
 * resolver form is not a literal to scrub or fall back on.
 */
export function resolveCursorStringApiKeySync(apiKey: ApiKey | undefined): string | undefined {
	return typeof apiKey === "string" ? resolveCursorApiKey(apiKey) : undefined;
}

/**
 * Resolve the runtime API key for discovery and turns.
 *
 * Env-only by design: OMP auto-loads ~/.omp/.env, so CURSOR_API_KEY is in
 * process.env. Earlier versions also opened a second sqlite connection to
 * OMP's agent.db (SqliteAuthCredentialStore) to read/write a stored
 * credential; that second connection's close() triggered macOS EXC_GUARD
 * kills (bun/sqlite guarded-fd close from a background thread — 9 identical
 * crash reports). The stored credential was never required: provider
 * availability comes from the registered config key (see index.ts), and keys
 * saved for the plugin's own provider id are resolved by
 * ctx.modelRegistry.getApiKeyForProvider(CURSOR_PROVIDER) at turn time. The
 * built-in OMP `cursor` provider's OAuth credential is never read.
 */
export async function resolveCursorRuntimeApiKey(): Promise<string | undefined> {
	return resolveCursorApiKey(process.env.CURSOR_API_KEY);
}
