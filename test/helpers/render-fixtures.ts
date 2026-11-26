import { isUiNode, type JSXNode } from "@oh-my-pi/pi-tui";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { RegisteredTool } from "./pi-harness-types.js";

type ToolRenderCall = NonNullable<RegisteredTool["renderCall"]>;
type ToolRenderResult = NonNullable<RegisteredTool["renderResult"]>;

export type HarnessRenderTheme = Parameters<ToolRenderCall>[1];
export type HarnessRenderContext = Parameters<ToolRenderCall>[2];
type HarnessRenderContextWithObjectArgs = Omit<HarnessRenderContext, "args"> & { args: object };
export type HarnessRenderResultOptions = Parameters<ToolRenderResult>[1];

export function createRenderTheme(overrides: Partial<HarnessRenderTheme> = {}): HarnessRenderTheme {
	return {
		fg: (_style: string, text: string) => text,
		bold: (text: string) => text,
		...overrides,
	} as HarnessRenderTheme;
}

export function createRenderOptions(overrides: Partial<HarnessRenderResultOptions> = {}): HarnessRenderResultOptions {
	return {
		expanded: false,
		isPartial: false,
		...overrides,
	};
}

export function createRenderContext(overrides: Partial<HarnessRenderContext> & { args?: object } = {}): HarnessRenderContextWithObjectArgs {
	return {
		args: {},
		toolCallId: "test-tool-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

/** Paints a renderer's node at `width` with omp's terminal painters; an empty render is "". */
export function paintRenderedNode(node: JSXNode, width: number): string {
	if (node === undefined) return "";
	if (!isUiNode(node)) throw new Error(`expected a pi-tui node, got ${typeof node}`);
	return renderBlock(node, width, { theme: PLAIN_THEME }).rows.join("\n");
}
