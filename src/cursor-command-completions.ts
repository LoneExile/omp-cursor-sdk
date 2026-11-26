// Type-only: erased at load, so a moved omp file cannot stop the extension from loading.
import type { AutocompleteItem } from "@oh-my-pi/pi-coding-agent/autocomplete/autocomplete";

/**
 * Argument completions for a slash command whose arguments are a few fixed words. `optionsAfter` gets the words
 * already typed before the word under the cursor and returns the options for that word, or `undefined` when nothing
 * completes there. Options match the typed word by case-insensitive prefix, as omp's own commands do. omp replaces the
 * whole argument text with the chosen value, so each value is prefixed with the words before it.
 */
export function completeCursorCommandArguments(
	prefix: string,
	optionsAfter: (previousWords: readonly string[]) => readonly AutocompleteItem[] | undefined,
): AutocompleteItem[] | null {
	const words = prefix.trimStart().split(/\s+/);
	const typed = (words.pop() ?? "").toLowerCase();
	const lead = words.length > 0 ? `${words.join(" ")} ` : "";
	const matches = (optionsAfter(words) ?? [])
		.filter((option) => option.label.toLowerCase().startsWith(typed))
		.map((option) => ({ ...option, value: `${lead}${option.value}` }));
	return matches.length > 0 ? matches : null;
}
