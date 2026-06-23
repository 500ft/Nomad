import type { OpenAlexWork } from "../types";
import { detectDriftConflict, reconstructAbstract, tokenize } from "./text";

export type RelevanceVerdict = "keep" | "warn" | "reject";
export type RelevanceReason =
  | "low-cosine-similarity"
  | "drift-domain-conflict"
  | "no-content";

export type RelevanceResult = {
  work: OpenAlexWork;
  verdict: RelevanceVerdict;
  cosine: number;
  coverage: number;
  effectiveScore: number;
  reasons: RelevanceReason[];
  driftDomains: string[];
};

export type RelevanceSummary = {
  kept: OpenAlexWork[];
  warned: RelevanceResult[];
  rejected: RelevanceResult[];
  results: RelevanceResult[];
  rejectionReasons: Record<RelevanceReason, number>;
};

const REJECT_THRESHOLD = 0.4;
const WARN_THRESHOLD = 0.6;

/** Build a paper's combined text used for TF-IDF and drift checks. */
function paperText(w: OpenAlexWork): string {
  const parts: string[] = [];
  if (w.display_name) parts.push(w.display_name);
  if (w.primary_topic?.display_name) parts.push(w.primary_topic.display_name);
  for (const t of w.topics ?? []) if (t?.display_name) parts.push(t.display_name);
  for (const k of w.keywords ?? []) if (k?.display_name) parts.push(k.display_name);
  parts.push(reconstructAbstract(w.abstract_inverted_index));
  return parts.join(" ");
}

/** Tokens used specifically for drift checks (avoid stop-word filtering on hospitality terms). */
function paperDriftTokens(w: OpenAlexWork): Set<string> {
  const text = [
    w.display_name ?? "",
    w.primary_topic?.display_name ?? "",
    ...(w.topics ?? []).map((t) => t?.display_name ?? ""),
    ...(w.keywords ?? []).map((k) => k?.display_name ?? "")
  ].join(" ");
  return new Set(tokenize(text));
}

export function filterByRelevance(query: string, works: OpenAlexWork[]): RelevanceSummary {
  const queryTokens = new Set(tokenize(query));
  const docTokenLists = works.map((w) => tokenize(paperText(w)));

  // Build IDF over the document corpus
  const N = Math.max(1, works.length);
  const df = new Map<string, number>();
  for (const tokens of docTokenLists) {
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [t, c] of df) {
    idf.set(t, Math.log(1 + N / c));
  }

  function vectorize(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, count] of tf) {
      const w = (idf.get(t) ?? 0) * (1 + Math.log(count));
      if (w > 0) v.set(t, w);
    }
    return v;
  }

  function cosine(a: Map<string, number>, b: Map<string, number>): number {
    if (!a.size || !b.size) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [, w] of a) na += w * w;
    for (const [, w] of b) nb += w * w;
    const small = a.size <= b.size ? a : b;
    const big = small === a ? b : a;
    for (const [t, w] of small) {
      const wb = big.get(t);
      if (wb) dot += w * wb;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // Vectorize the query against the corpus IDF (any token not in the corpus contributes 0).
  const queryVector = vectorize(Array.from(queryTokens));
  const queryTokenList = Array.from(queryTokens);

  const results: RelevanceResult[] = works.map((work, i) => {
    const docVec = vectorize(docTokenLists[i]);
    const sim = cosine(queryVector, docVec);
    const docTokenSet = new Set(docTokenLists[i]);
    const coverage = queryTokenList.length
      ? queryTokenList.filter((t) => docTokenSet.has(t)).length / queryTokenList.length
      : 0;
    // Short queries get rescued by coverage; long queries lean on cosine.
    const effective = Math.max(coverage, sim * 1.4);
    const driftTokens = paperDriftTokens(work);
    const drift = detectDriftConflict(queryTokens, driftTokens);
    const reasons: RelevanceReason[] = [];

    if (!docTokenLists[i].length) {
      reasons.push("no-content");
    }
    if (effective < REJECT_THRESHOLD) {
      reasons.push("low-cosine-similarity");
    }
    if (drift.conflict) {
      reasons.push("drift-domain-conflict");
    }

    let verdict: RelevanceVerdict;
    if (drift.conflict || effective < REJECT_THRESHOLD) {
      verdict = "reject";
    } else if (effective < WARN_THRESHOLD) {
      verdict = "warn";
    } else {
      verdict = "keep";
    }

    return {
      work,
      verdict,
      cosine: sim,
      coverage,
      effectiveScore: effective,
      reasons,
      driftDomains: drift.domains
    };
  });

  const kept: OpenAlexWork[] = [];
  const warned: RelevanceResult[] = [];
  const rejected: RelevanceResult[] = [];
  const rejectionReasons: Record<RelevanceReason, number> = {
    "low-cosine-similarity": 0,
    "drift-domain-conflict": 0,
    "no-content": 0
  };

  for (const r of results) {
    kept.push(r.work);
    if (r.verdict === "reject") {
      rejected.push(r);
      for (const reason of r.reasons) rejectionReasons[reason]++;
    } else if (r.verdict === "warn") {
      warned.push(r);
    }
  }

  return { kept, warned, rejected, results, rejectionReasons };
}

export const RELEVANCE_THRESHOLDS = {
  reject: REJECT_THRESHOLD,
  warn: WARN_THRESHOLD
} as const;
