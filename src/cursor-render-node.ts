import { jsx, type JSXNode } from "@oh-my-pi/pi-tui";

/**
 * Renderer text as a pi-tui `ansi` node. The host keeps the text's SGR styling (the extension
 * theme's colors) and wraps each line to the width, in the terminal and in Tern. Empty text draws
 * nothing.
 */
export function cursorAnsiNode(text: string): JSXNode {
	return text ? jsx("ansi", { text }) : undefined;
}
