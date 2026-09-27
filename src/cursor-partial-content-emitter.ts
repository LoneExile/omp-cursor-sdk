import type { AssistantMessage, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

const DEFAULT_THINKING_TRACE_MAX_CHARS = 50000;

/**
 * Newlines that make the text so far end in exactly one blank line before the next SDK
 * assistant message. Newlines the model already emitted count toward it and are never
 * removed. `parts` is the text in order (token deltas or whole strings).
 */
export function cursorTextMessageSeparator(parts: readonly string[]): string {
	let trailing = 0;
	for (let index = parts.length - 1; index >= 0 && trailing < 2; index -= 1) {
		const part = parts[index];
		let charIndex = part.length - 1;
		while (charIndex >= 0 && trailing < 2 && part[charIndex] === "\n") {
			trailing += 1;
			charIndex -= 1;
		}
		if (charIndex >= 0) break;
	}
	return "\n".repeat(2 - trailing);
}

export interface CursorPartialContentEmitterOptions {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	thinkingMaxChars?: number;
	mutuallyExclusive?: boolean;
}

export class CursorPartialContentEmitter {
	private thinkingContentIndex = -1;
	private textContentIndex = -1;
	private textMessageCompleted = false;
	private activityTraceChars = 0;
	private activityTraceTruncated = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly partial: AssistantMessage,
		private readonly thinkingMaxChars = DEFAULT_THINKING_TRACE_MAX_CHARS,
		private readonly mutuallyExclusive = true,
	) {}

	closeThinking(): void {
		if (this.thinkingContentIndex < 0) return;
		const block = this.partial.content[this.thinkingContentIndex];
		if (block.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: this.thinkingContentIndex,
				content: block.thinking,
				partial: this.partial,
			});
		}
		this.thinkingContentIndex = -1;
	}

	closeText(): string {
		if (this.textContentIndex < 0) return "";
		const contentIndex = this.textContentIndex;
		const block = this.partial.content[contentIndex];
		this.textContentIndex = -1;
		if (block.type !== "text") return "";
		this.stream.push({
			type: "text_end",
			contentIndex,
			content: block.text,
			partial: this.partial,
		});
		return block.text;
	}

	closeAll(): string {
		this.closeThinking();
		return this.closeText();
	}

	appendThinkingDelta(delta: string, options?: { closeText?: boolean }): void {
		const closeText = options?.closeText ?? this.mutuallyExclusive;
		if (closeText) this.closeText();
		if (this.activityTraceTruncated || !delta) return;

		let text = delta;
		if (this.thinkingMaxChars >= 0 && this.activityTraceChars + text.length > this.thinkingMaxChars) {
			const remainingChars = Math.max(this.thinkingMaxChars - this.activityTraceChars, 0);
			text = `${text.slice(0, remainingChars)}\n[Cursor activity trace truncated]\n`;
			this.activityTraceTruncated = true;
		}
		if (!text) return;

		if (this.thinkingContentIndex < 0) {
			this.thinkingContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.thinkingContentIndex, partial: this.partial });
		}
		const block = this.partial.content[this.thinkingContentIndex];
		if (block.type !== "thinking") return;
		block.thinking += text;
		this.activityTraceChars += text.length;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: this.thinkingContentIndex,
			delta: text,
			partial: this.partial,
		});
	}

	appendTextDelta(delta: string, options?: { closeThinking?: boolean }): void {
		const closeThinking = options?.closeThinking ?? this.mutuallyExclusive;
		if (closeThinking) this.closeThinking();
		if (!delta) return;
		if (this.textMessageCompleted) {
			this.textMessageCompleted = false;
			delta = this.textMessageBoundaryPrefix() + delta;
		}
		if (this.textContentIndex < 0) {
			this.textContentIndex = this.partial.content.length;
			this.partial.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textContentIndex, partial: this.partial });
		}
		const block = this.partial.content[this.textContentIndex];
		if (block.type !== "text") return;
		block.text += delta;
		this.stream.push({
			type: "text_delta",
			contentIndex: this.textContentIndex,
			delta,
			partial: this.partial,
		});
	}

	/**
	 * omp renders one text block as one Markdown run in the TUI and writes each text block
	 * followed by "\n" in print mode (pi-coding-agent modes/print-mode.ts), while the TUI
	 * trims blocks and puts no space between adjacent text blocks. So a boundary inside
	 * the still-open block gets the full separator and stays in that block; after a block
	 * that a trace closed, print mode's own newline already counts and no
	 * separator-only block is created.
	 */
	private textMessageBoundaryPrefix(): string {
		const open = this.textContentIndex >= 0 ? this.partial.content[this.textContentIndex] : undefined;
		if (open?.type === "text") return cursorTextMessageSeparator([open.text]);
		for (let index = this.partial.content.length - 1; index >= 0; index -= 1) {
			const block = this.partial.content[index];
			if (block.type === "text") return cursorTextMessageSeparator([block.text, "\n"]);
		}
		return "";
	}

	completeTextMessage(): void {
		this.textMessageCompleted = this.partial.content.some((block) => block.type === "text" && block.text.length > 0);
	}

	appendThinkingBlock(text: string, options?: { closeText?: boolean }): void {
		const closeText = options?.closeText ?? this.mutuallyExclusive;
		if (closeText) this.closeAll();
		else this.closeThinking();
		this.appendThinkingDelta(text.endsWith("\n") ? text : `${text}\n`, { closeText: false });
		this.closeThinking();
	}

	flushText(deltas: string[]): string {
		for (const delta of deltas) this.appendTextDelta(delta);
		return this.closeText();
	}
}
