import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent";
import { expect } from "vitest";

// Shared by the prompt-assembly suites (context.test.ts, cursor-cloud-prompt-context.test.ts).
// OMP providers receive messages already converted by the host's convertToLlm: `!` and Python
// output become `user` messages (`!!` and `$$` output is dropped, `excludeFromContext`); extension
// custom messages and text @file mentions become `developer` messages; an image-bearing custom
// message becomes a `developer` message plus a synthetic `user` message ("Images attached to
// <type>."); an @file image mention becomes one `user` message with its images; a compaction or
// branch summary becomes a `user` message with `historyRewriteAt` (pi-agent-core
// convertMessageToLlm, pi-coding-agent session/messages.ts).
export function hostMessages(messages: unknown[]): Message[] {
	return convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
}

/** Every section is present in `text`, in the given order. */
export function expectInOrder(text: string, sections: string[]) {
	const positions = sections.map((section) => text.indexOf(section));
	expect(positions.every((position) => position >= 0)).toBe(true);
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

export function assistantReply(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk",
		provider: "cursor-sdk",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

export const promptImage = { type: "image" as const, data: "prompt-image-b64", mimeType: "image/png" };
export const noteImage = { type: "image" as const, data: "note-image-b64", mimeType: "image/jpeg" };
export const shotImage = { type: "image" as const, data: "shot-image-b64", mimeType: "image/png" };
export const frameImage = { type: "image" as const, data: "frame-image-b64", mimeType: "image/webp" };

/** The `SDKImage` each image above is sent as. */
export const promptImages = [{ data: "prompt-image-b64", mimeType: "image/png" }];
export const noteImages = [{ data: "note-image-b64", mimeType: "image/jpeg" }];
export const shotImages = [{ data: "shot-image-b64", mimeType: "image/png" }];
export const frameImages = [{ data: "frame-image-b64", mimeType: "image/webp" }];

/** An answered first turn; the long request makes a tight budget trim it. */
export const history = [
	{ role: "user", content: `Refactor the parser ${"x".repeat(1500)}`, timestamp: 1 },
	assistantReply("Parser refactored.", 2),
];
export const planNotice = { role: "custom", customType: "plan-mode-context", content: "Plan mode is active.", display: false, timestamp: 3 };
export const prompt = { role: "user", content: [{ type: "text", text: "Fix the flaky test" }, promptImage], timestamp: 3 };
export const imageHook = {
	role: "custom",
	customType: "screenshot-note",
	content: [{ type: "text", text: "Attached by hook." }, noteImage],
	display: false,
	timestamp: 3,
};
export const branchSummary = { role: "branchSummary", summary: "Tried approach A. secret=XYZ", fromId: "entry-a", timestamp: 3 };

export function compactionSummary(summary: string, images: unknown[] = []) {
	return { role: "compactionSummary", summary, tokensBefore: 12000, images, timestamp: 3 };
}
