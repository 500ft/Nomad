import type { CitationYear } from "./types";

export function visibleCitationHistory(history: CitationYear[]): CitationYear[] {
  return history.filter((item) => item.citationCount > 0);
}
