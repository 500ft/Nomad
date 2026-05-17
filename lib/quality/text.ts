// Pure text utilities for the v2 quality pipeline.
// No external deps. Tokenization is intentionally aggressive — reduces drift
// by stripping punctuation, lowercasing, and dropping very short or stopword tokens.

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "this", "to", "was", "were", "will", "with", "we", "our", "you", "your",
  "based", "using", "review", "study", "studies", "research", "paper", "papers",
  "approach", "method", "methods", "model", "models", "analysis", "analyses",
  "system", "systems", "application", "applications", "use", "used", "between",
  "via", "toward", "towards", "new", "novel", "recent", "recently", "advances",
  "advanced"
]);

export function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const positions: Array<[number, string]> = [];
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of idxs) positions.push([i, word]);
  }
  positions.sort(([a], [b]) => a - b);
  return positions.map(([, w]) => w).join(" ");
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

export function uniqueTokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Drift-domain heuristic. If the user's query has no overlap with any of these
 * domain "intent" terms, but a candidate paper does, that's strong drift.
 */
export const DRIFT_DOMAINS: Record<string, string[]> = {
  hospitality: ["hotel", "hotels", "hospitality", "tourism", "restaurant", "lodging", "guest", "guests"],
  marketing: ["marketing", "branding", "advertising", "advertisement", "shopper"],
  finance: ["banking", "investor", "stockholder", "shareholder", "portfolio", "dividend", "fintech", "trading"]
};

export function detectDriftConflict(queryTokens: Set<string>, paperTokens: Set<string>): {
  conflict: boolean;
  domains: string[];
} {
  const conflictDomains: string[] = [];
  for (const [domain, terms] of Object.entries(DRIFT_DOMAINS)) {
    const queryHasIt = terms.some((t) => queryTokens.has(t));
    if (queryHasIt) continue; // user wants this domain
    const hits = terms.filter((t) => paperTokens.has(t)).length;
    if (hits >= 2) conflictDomains.push(domain);
  }
  return { conflict: conflictDomains.length > 0, domains: conflictDomains };
}
