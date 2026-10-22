import { expect } from "vitest";

// Helpers for contract tests that read the installed SDK's minified source. The SDK is rebuilt with new
// minifier-assigned names on every release, so a test may pin the shape of the code but never a name:
// patterns capture names with `IDENT` and carry them forward with back-references.

/** A minified identifier. */
export const IDENT = "[\\w$]+";

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The one match of `pattern` in `source`, or a failure naming `fact` and the pattern. */
export function onlyMatch(source: string, pattern: string, fact: string): RegExpMatchArray {
	const matches = [...source.matchAll(new RegExp(pattern, "g"))];
	expect(matches.length, `${fact} (pattern ${pattern})`).toBe(1);
	return matches[0]!;
}

/** Source of the declaration whose body opens at the first `{` after `start`, balanced on braces outside string literals. */
export function balancedDeclaration(source: string, start: number): string {
	let depth = 0;
	let quote: string | undefined;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		const char = source[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && --depth === 0) {
			return source.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced declaration at offset ${start}`);
}
