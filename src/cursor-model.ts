import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// OMP ships a built-in OAuth `cursor` provider (api `cursor-agent`, 18.x). Registering
// under that id would merge both catalogs and let this plugin's Cursor-only hooks claim
// built-in rows, so the plugin owns its own provider id.
export const CURSOR_PROVIDER = "cursor-sdk";
export const CURSOR_SDK_API = "cursor-sdk";

export type CursorModelRef =
	| Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api">
	| undefined;

export function isCursorModel(model: CursorModelRef): boolean {
	return model?.provider === CURSOR_PROVIDER || model?.api === CURSOR_SDK_API;
}
