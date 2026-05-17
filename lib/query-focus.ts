const MAX_SUGGESTIONS = 3;
const MAX_MEANINGFUL_TOKENS = 12;
const LONG_QUERY_TOKEN_THRESHOLD = 8;
const LONG_QUERY_CHAR_THRESHOLD = 55;
const REPEATED_PHRASE_NGRAMS = [2, 3] as const;

const DOMAIN_PRIORITY: DomainPackId[] = ["hvac-cfd", "robotics", "battery-thermal", "generic"];

const QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "based",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "machine",
  "learning",
  "of",
  "on",
  "or",
  "research",
  "the",
  "to",
  "using",
  "with"
]);

const TECHNICAL_ACRONYMS = new Set(["ai", "cfd", "fea", "pid", "rl", "hvac"]);

const GENERIC_ANCHORS = new Set([
  "analysis",
  "application",
  "approach",
  "based",
  "design",
  "engineering",
  "experimental",
  "improvement",
  "method",
  "model",
  "modeling",
  "optimization",
  "performance",
  "prediction",
  "simulation",
  "study",
  "system",
  "technical"
]);

const DOMAIN_TRIGGERS: Record<Exclude<DomainPackId, "generic">, string[]> = {
  "hvac-cfd": ["hvac", "cfd", "airflow", "diffuser", "ventilation", "building", "indoor", "comfort", "thermal"],
  robotics: ["robot", "robots", "robotic", "robotics", "gripper", "manipulation", "actuator", "navigation", "mobile"],
  "battery-thermal": ["battery", "batteries", "thermal", "cooling", "lithium", "ion", "pack", "packs", "cell", "cells", "heat", "temperature"]
};

type DomainPackId = "hvac-cfd" | "robotics" | "battery-thermal" | "generic";
type AddedConstraintType = "method" | "application" | "system" | "outcome";

type ParsedTopic = {
  original: string;
  normalized: string;
  meaningfulTokens: string[];
  anchors: string[];
  phrases: string[];
  isLong: boolean;
};

type QuerySuggestionCandidate = {
  text: string;
  domain: DomainPackId;
  addedConstraintType: AddedConstraintType;
  order: number;
};

type ScoredCandidate = QuerySuggestionCandidate & {
  score: number;
  tokenCount: number;
};

export function buildQueryFocusSuggestions(topic: string): string[] {
  const parsed = parseTopic(topic);
  const domains = detectDomainPack(parsed);
  const candidates = generateCandidates(parsed, domains);
  const filtered = filterCandidates(candidates, parsed);
  const scored = scoreCandidates(filtered, parsed, domains);

  return dedupeAndTakeTop(scored, MAX_SUGGESTIONS);
}

export function cleanSuggestion(input: string): string {
  const words = input.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const result: string[] = [];

  for (const word of words) {
    result.push(word);

    if (result.length >= 2 && result[result.length - 1].toLowerCase() === result[result.length - 2].toLowerCase()) {
      result.pop();
    }

    for (let size = 5; size >= 2; size -= 1) {
      if (result.length >= size * 2) {
        const first = result.slice(result.length - size * 2, result.length - size).join(" ").toLowerCase();
        const second = result.slice(result.length - size).join(" ").toLowerCase();
        if (first === second) {
          result.splice(result.length - size, size);
        }
      }
    }
  }

  return result.join(" ").trim();
}

function parseTopic(topic: string): ParsedTopic {
  const normalized = normalizeQueryText(topic);
  const meaningfulTokens = meaningfulTokensFor(topic);
  const anchorSet = new Set(meaningfulTokens.filter((token) => !GENERIC_ANCHORS.has(token)));
  const anchors = anchorSet.size ? Array.from(anchorSet) : Array.from(new Set(meaningfulTokens));
  const phrases = [...extractNgrams(meaningfulTokens, 2), ...extractNgrams(meaningfulTokens, 3)];

  return {
    original: topic,
    normalized,
    meaningfulTokens,
    anchors,
    phrases,
    isLong: meaningfulTokens.length >= LONG_QUERY_TOKEN_THRESHOLD || normalized.length >= LONG_QUERY_CHAR_THRESHOLD
  };
}

function detectDomainPack(parsed: ParsedTopic): DomainPackId[] {
  const scoredDomains = (Object.entries(DOMAIN_TRIGGERS) as Array<[Exclude<DomainPackId, "generic">, string[]]>)
    .map(([domain, triggers]) => ({
      domain,
      count: parsed.meaningfulTokens.filter((token) => triggers.includes(token)).length
    }))
    .filter((item) => item.count > 0);

  if (!scoredDomains.length) {
    return ["generic"];
  }

  const maxCount = Math.max(...scoredDomains.map((item) => item.count));
  const tied = scoredDomains
    .filter((item) => item.count === maxCount)
    .map((item) => item.domain)
    .sort((a, b) => domainPriority(a) - domainPriority(b));

  if (tied.length > 1) {
    return ["generic", tied[0]];
  }

  return [tied[0]];
}

function generateCandidates(parsed: ParsedTopic, domains: DomainPackId[]): QuerySuggestionCandidate[] {
  const candidates: QuerySuggestionCandidate[] = [];
  for (const domain of domains) {
    if (domain !== "generic") {
      candidates.push(...domainCandidates(parsed, domain));
    }
  }
  candidates.push(...genericCandidates(parsed));

  return candidates
    .map((candidate, order) => ({ ...candidate, text: cleanSuggestion(candidate.text), order }))
    .filter((candidate) => candidate.text.length > 0);
}

function filterCandidates(candidates: QuerySuggestionCandidate[], parsed: ParsedTopic): QuerySuggestionCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const normalized = normalizeQueryText(candidate.text);
    if (!normalized || seen.has(normalized)) {
      return false;
    }

    const tokens = meaningfulTokensFor(candidate.text);
    if (!containsAnchor(tokens, parsed.anchors) || tokens.length > MAX_MEANINGFUL_TOKENS) {
      return false;
    }

    if (hasRepeatedNgram(tokens) || repeatedTokenShare(tokens) > 0.45) {
      return false;
    }

    if (containsExistingPhraseWithoutConstraint(candidate, parsed)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
}

function scoreCandidates(candidates: QuerySuggestionCandidate[], parsed: ParsedTopic, domains: DomainPackId[]): ScoredCandidate[] {
  return candidates.map((candidate) => {
    const tokens = meaningfulTokensFor(candidate.text);
    const anchorPreservationScore = containsAnchor(tokens, parsed.anchors) ? 1 : 0;
    const domainSpecificityScore = domainSpecificity(candidate, tokens, domains);
    const addedConstraintScore = addsUsefulConstraint(candidate, parsed) ? 1 : 0;
    const concisionScore = clamp01(1 - Math.max(0, tokens.length - 8) / 4);
    const cleanlinessScore = hasRepeatedNgram(tokens) || repeatedTokenShare(tokens) > 0.45 ? 0 : 1;
    const score =
      0.3 * anchorPreservationScore +
      0.25 * domainSpecificityScore +
      0.2 * addedConstraintScore +
      0.15 * concisionScore +
      0.1 * cleanlinessScore;

    return {
      ...candidate,
      score,
      tokenCount: tokens.length
    };
  });
}

function dedupeAndTakeTop(candidates: ScoredCandidate[], count: number): string[] {
  return candidates
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (domainPriority(a.domain) !== domainPriority(b.domain)) return domainPriority(a.domain) - domainPriority(b.domain);
      if (a.tokenCount !== b.tokenCount) return a.tokenCount - b.tokenCount;
      return a.order - b.order;
    })
    .slice(0, count)
    .map((candidate) => candidate.text);
}

function domainCandidates(parsed: ParsedTopic, domain: DomainPackId): QuerySuggestionCandidate[] {
  const anchor = preferredAnchor(parsed, domain);

  if (domain === "hvac-cfd") {
    return [
      candidate("machine learning surrogate modeling for HVAC airflow prediction", domain, "method"),
      candidate("CFD surrogate models for diffuser pressure drop prediction", domain, "outcome"),
      candidate("reduced order modeling for indoor thermal comfort prediction", domain, "method"),
      candidate("HVAC diffuser airflow prediction with CFD validation", domain, "application"),
      candidate("CFD modeling for room ventilation pressure loss", domain, "outcome")
    ];
  }

  if (domain === "robotics") {
    return [
      candidate("soft robotics grippers for delicate object manipulation", domain, "application"),
      candidate("robotics force control for gripper design", domain, "method"),
      candidate("robotics navigation error reduction for mobile robots", domain, "outcome"),
      candidate("robotics actuator design for compliant manipulation", domain, "system"),
      candidate("robotics trajectory tracking with disturbance rejection", domain, "method")
    ];
  }

  if (domain === "battery-thermal") {
    return [
      candidate("battery thermal management cooling plate optimization", domain, "system"),
      candidate("temperature uniformity prediction for battery packs", domain, "outcome"),
      candidate("heat generation modeling for lithium ion battery cells", domain, "method"),
      candidate("battery pack cooling design for thermal runaway reduction", domain, "outcome"),
      candidate("thermal management modeling for fast charging battery packs", domain, "application")
    ];
  }

  return [
    candidate(`${anchor} design optimization with measurable performance metrics`, domain, "outcome"),
    candidate(`${anchor} modeling for experimental validation`, domain, "method"),
    candidate(`${anchor} control strategy for efficiency improvement`, domain, "method")
  ];
}

function genericCandidates(parsed: ParsedTopic): QuerySuggestionCandidate[] {
  const tokens = new Set(parsed.meaningfulTokens);
  const anchor = preferredAnchor(parsed, "generic");

  if (tokens.has("composite") || tokens.has("material") || tokens.has("materials")) {
    return [
      candidate("composite fatigue life prediction", "generic", "outcome"),
      candidate("fiber reinforced composite delamination modeling", "generic", "method"),
      candidate("composite materials fatigue testing methods", "generic", "application")
    ];
  }

  if (tokens.has("fatigue") || tokens.has("stress")) {
    return [
      candidate(`${anchor} fatigue life prediction`, "generic", "outcome"),
      candidate(`${anchor} crack initiation modeling`, "generic", "method"),
      candidate(`${anchor} stress concentration reduction`, "generic", "outcome")
    ];
  }

  if (tokens.has("heat") || tokens.has("exchanger")) {
    return [
      candidate(`${anchor} pressure drop reduction`, "generic", "outcome"),
      candidate(`${anchor} thermal performance prediction`, "generic", "outcome"),
      candidate(`${anchor} geometry optimization`, "generic", "system")
    ];
  }

  if (tokens.has("fluid") || tokens.has("fluids") || tokens.has("flow")) {
    return [
      candidate(`${anchor} pressure loss prediction`, "generic", "outcome"),
      candidate(`${anchor} boundary layer control`, "generic", "method"),
      candidate(`${anchor} turbulence modeling for experimental validation`, "generic", "method")
    ];
  }

  if (tokens.has("manufacturing") || tokens.has("additive")) {
    return [
      candidate(`${anchor} process parameter optimization`, "generic", "method"),
      candidate(`${anchor} surface roughness prediction`, "generic", "outcome"),
      candidate(`${anchor} print strength improvement`, "generic", "outcome")
    ];
  }

  if (tokens.has("control") || tokens.has("motor")) {
    return [
      candidate(`${anchor} PID tuning for disturbance rejection`, "generic", "method"),
      candidate(`${anchor} trajectory tracking control`, "generic", "method"),
      candidate(`${anchor} efficiency improvement with measurable metrics`, "generic", "outcome")
    ];
  }

  return [
    candidate(`${anchor} design optimization with measurable performance metrics`, "generic", "outcome"),
    candidate(`${anchor} modeling for experimental validation`, "generic", "method"),
    candidate(`${anchor} control strategy for efficiency improvement`, "generic", "method"),
    candidate(`${anchor} performance prediction using benchmark datasets`, "generic", "outcome")
  ];
}

function candidate(text: string, domain: DomainPackId, addedConstraintType: AddedConstraintType): QuerySuggestionCandidate {
  return {
    text,
    domain,
    addedConstraintType,
    order: 0
  };
}

function preferredAnchor(parsed: ParsedTopic, domain: DomainPackId): string {
  const triggers = domain === "generic" ? [] : DOMAIN_TRIGGERS[domain];
  return parsed.anchors.find((anchor) => triggers.includes(anchor)) ?? parsed.anchors[0] ?? "engineering";
}

function containsAnchor(tokens: string[], anchors: string[]): boolean {
  return anchors.some((anchor) => tokens.includes(anchor));
}

function containsExistingPhraseWithoutConstraint(candidate: QuerySuggestionCandidate, parsed: ParsedTopic): boolean {
  const tokens = meaningfulTokensFor(candidate.text);
  const candidatePhrases = new Set([...extractNgrams(tokens, 2), ...extractNgrams(tokens, 3)]);
  const hasExistingPhrase = parsed.phrases.some((phrase) => candidatePhrases.has(phrase));

  return hasExistingPhrase && !addsUsefulConstraint(candidate, parsed);
}

function addsUsefulConstraint(candidate: QuerySuggestionCandidate, parsed: ParsedTopic): boolean {
  const tokens = meaningfulTokensFor(candidate.text);
  const originalTokens = new Set(parsed.meaningfulTokens);
  const newTokens = tokens.filter((token) => !originalTokens.has(token));

  if (!newTokens.length && !parsed.isLong) {
    return false;
  }

  return constraintTokens(candidate.addedConstraintType).some((token) => tokens.includes(token) || newTokens.includes(token));
}

function constraintTokens(type: AddedConstraintType): string[] {
  if (type === "method") return ["modeling", "models", "surrogate", "control", "tuning", "validation", "methods"];
  if (type === "application") return ["airflow", "diffuser", "manipulation", "charging", "testing", "ventilation"];
  if (type === "system") return ["plate", "pack", "actuator", "geometry", "gripper", "design"];
  return ["prediction", "reduction", "optimization", "uniformity", "performance", "efficiency", "loss"];
}

function domainSpecificity(candidate: QuerySuggestionCandidate, tokens: string[], domains: DomainPackId[]): number {
  if (candidate.domain === "generic") {
    return domains.includes("generic") ? 1 : 0.6;
  }

  const triggers = DOMAIN_TRIGGERS[candidate.domain];
  const triggerMatches = tokens.filter((token) => triggers.includes(token)).length;
  const selectedDomainBonus = domains.includes(candidate.domain) ? 0.4 : 0;

  return clamp01(selectedDomainBonus + triggerMatches / 3);
}

function normalizeQueryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokensFor(text: string): string[] {
  return normalizeQueryText(text)
    .split(" ")
    .filter((token) => token && !QUERY_STOPWORDS.has(token))
    .filter((token) => token.length >= 3 || TECHNICAL_ACRONYMS.has(token));
}

function extractNgrams(tokens: string[], size: 2 | 3): string[] {
  const phrases: string[] = [];
  for (let index = 0; index <= tokens.length - size; index += 1) {
    phrases.push(tokens.slice(index, index + size).join(" "));
  }
  return phrases;
}

function hasRepeatedNgram(tokens: string[]): boolean {
  for (const size of REPEATED_PHRASE_NGRAMS) {
    const seen = new Set<string>();
    for (const phrase of extractNgrams(tokens, size)) {
      if (seen.has(phrase)) return true;
      seen.add(phrase);
    }
  }
  return false;
}

function repeatedTokenShare(tokens: string[]): number {
  if (!tokens.length) return 0;
  const unique = new Set(tokens);
  return (tokens.length - unique.size) / tokens.length;
}

function domainPriority(domain: DomainPackId): number {
  return DOMAIN_PRIORITY.indexOf(domain);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
