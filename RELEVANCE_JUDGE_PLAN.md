# Nomad — LLM Abstract-Judge Relevance Layer (Design / Plan)

**Status:** design only, no code written.
**Decisions locked:** abstract now / full-text later · hard filter + rerank · deterministic-given-cache · OpenAI (already a dependency).

---

## 1. Problem statement (engineering, not marketing)

Off-topic papers surface because the relevance signal is lexical, not semantic-in-the-meaningful-sense.

Current blend (`lib/embeddings.ts:43`, `lib/scoring.ts:288`):

```
finalRelevanceScore = 0.45·keywordRelevance + 0.35·semantic + 0.20·citationPercentile
```

- `keywordRelevance` (`searchOrderRelevance`, `scoring.ts:2028`) = OpenAlex search order + raw term overlap against title/topics/keywords. **45% of the blend rewards term matching directly.**
- `semantic` = cosine similarity of `text-embedding-3-small` over `compactText` (title + abstract + topic labels + keywords, `scoring.ts:219`). Embeddings measure surface proximity; "battery thermal management" sits near any paper that *says* those words regardless of its actual contribution. The model has no representation of "what is this paper about." Concatenating keyword/topic labels into `compactText` **inflates** the lexical overlap further.

Net: nothing in the pipeline reads a paper and decides whether it is *about* the query. That is the gap.

## 2. Approach: retrieve-then-rerank with an abstract judge

Do **not** replace the existing scores. Use them as a cheap first-stage retriever, then run an LLM relevance judge over the top candidates only. The judge reads title + abstract + topics and returns a structured verdict. Verdict is used two ways (per locked decision): **hard-filter** clearly off-topic papers, and **rerank** by folding a graded relevance into the blend.

Why gate to top-K instead of judging everything: embeddings batch ~200 works in 1–2 API calls; a naive per-paper judge is ~200 calls/query (50–100× cost + latency). Gating + batching keeps it to a handful of calls.

## 3. New module: `lib/relevance-judge.ts`

Mirrors the shape of `embeddings.ts` (cache + signals + graceful no-key fallback) and the **injectable-dependency pattern already used in `buildResearchMap`** (`citationHistoryFetcher`, `referenceFetcher` are passed in — do the same for the judge so tests never hit the network).

### 3.1 Judge contract

```ts
export type JudgeVerdict = {
  workId: string;
  onTopic: boolean;          // false => hard-filter candidate
  grade: 0 | 1 | 2 | 3;      // 0 off-topic, 1 tangential, 2 relevant, 3 core
  about: string;             // one line: what the paper is actually about
  reason: string;            // why this grade (audit/trace)
};
export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict[]>;
```

Use an **ordinal 0–3 scale, not a free float.** LLMs are far more consistent emitting a small labeled scale than a calibrated 0.00–1.00 number. Map to `[0,1]` deterministically: `gradeScore = grade / 3`.

### 3.2 Prompt design (abstract-level)

- Inputs per paper: query `topic`, `field`, `goal`; paper `title`, `abstractText`, primary topic + topic labels.
- Instruction: judge whether the paper's *core contribution* addresses the query topic, **not** whether the words appear. Explicitly tell it that shared terminology with a different application = `grade 0 or 1`.
- Force structured output: `response_format` JSON schema matching `JudgeVerdict[]`. Reject/retry on parse failure; on second failure, treat batch as unjudged (do not crash the map).
- Keep a `PROMPT_VERSION` constant; it is part of the cache key (below).

### 3.3 Batching & gating

- Gate: rank by first-stage `finalRelevanceScore`, take `JUDGE_CANDIDATE_LIMIT` (start **40**).
- Batch: `JUDGE_BATCH_SIZE` abstracts per call (start **8–10**) → ~4–5 calls/query worst case, ~0 on cache hit.
- Truncate each abstract to a `MAX_JUDGE_ABSTRACT_CHARS` budget (mirror `MAX_TEXT_LENGTH` logic in `embeddings.ts:150`).

### 3.4 Determinism-given-cache

- Pin `JUDGE_MODEL` (e.g. `gpt-4o-mini`), `temperature: 0`, `seed` fixed, JSON-schema output.
- Cache key: `hash(workId + abstractHash + query + JUDGE_MODEL + PROMPT_VERSION)` — same in-memory `Map` strategy as `embeddingCache` (`embeddings.ts:9`). Same input ⇒ same verdict for the life of the cache.
- **Honest caveat to document:** cache is in-process; cold start re-queries and the model can drift across provider updates. This is "reproducible while cached," not the bit-exact determinism the README currently claims. The README's "deterministic" wording should be amended to "deterministic given fixed inputs and cache / when the judge is disabled."

### 3.5 No-abstract handling (do not fake it)

`hasAbstract` is frequently false (OpenAlex coverage gap). A paper that cannot be judged must **not** be hard-filtered and must **not** be silently scored as on-topic. It keeps its first-stage score, is marked `judged:false`, and is counted in a limitation/warning. This is the single most common correctness trap in this feature — call it out in review.

## 4. Wiring into the pipeline (`buildResearchMap`, `scoring.ts:91`)

The judge must run **before** clustering/foundational/recent/people, because hard-filtering changes every downstream set.

Current order (`scoring.ts:99–103`):
```
normalizeWorks → scoreWorks → applySemanticRelevance → scoreWorks → buildClusters …
```

New order:
```
normalizeWorks
→ scoreWorks                       (first pass)
→ applySemanticRelevance
→ scoreWorks                       (gives finalRelevanceScore for gating)
→ applyAbstractJudge   [NEW]       (top-40 by finalRelevanceScore, batched)
→ reblend + rescore    [NEW]       (recompute finalRelevanceScore w/ judge term, then foundational/recent)
→ hard-filter off-topic [NEW]      (drop judged && grade 0 → `usableWorks`)
→ buildClusters(usableWorks) … rest unchanged, operating on the filtered set
```

Add `relevanceJudge: JudgeFn = defaultRelevanceJudge` as a 5th parameter to `buildResearchMap` so tests inject a stub.

## 5. Blend change

Extend `blendRelevance` (`embeddings.ts:43`) with the judge term. Proposed weights when a paper **is judged** (judge dominant, keyword demoted, embedding kept as a weak tiebreaker):

```
finalRelevance = 0.30·keyword + 0.45·judgeGrade + 0.10·semantic + 0.15·citationPercentile
```

Fallbacks:
- judged = false, semantic available → **current** formula unchanged (`0.45/0.35/0.20`).
- no semantic, no judge → keyword only (current behavior).

Weights are a starting point; tune on a labeled query set (§8) before locking. `foundationalScore`/`recentInfluenceScore` (`scoring.ts:299–308`) consume `finalRelevanceScore` unchanged, so they inherit the improvement automatically.

## 6. Type / signal changes

`NormalizedWork` (`types.ts:293`) add:
```ts
judgeGradeScore: number | null;   // grade/3, null if unjudged
judgeOnTopic: boolean | null;
judgeAbout: string | null;
judged: boolean;
```
`PaperRecommendation` (`types.ts:16`): surface `judgeAbout` + reason codes `llm-verified-on-topic` / `unverified-no-abstract`. Filtered papers carry `llm-off-topic-filtered` in diagnostics only.

New `JudgeSignals` (parallel to `SemanticSignals`, `types.ts:221`): `{ enabled, model, judgedCount, filteredOffTopicCount, unjudgedNoAbstractCount }`, returned in `ResearchMapResponse` and used for warnings.

New warnings (`buildWarnings`, `scoring.ts:1777`):
- `"LLM relevance judge unavailable; using embedding/keyword relevance only."`
- `"{n} papers had no abstract and could not be topic-verified."`
- `"{n} off-topic papers removed by relevance judge."` (transparency)

## 7. Cost & latency

- Per query (cold): ~40 candidates / 8 per batch = 5 calls of `gpt-4o-mini`, small prompts. Cents-scale, dominated by abstract tokens. Warm cache ≈ free.
- Latency: batches run in parallel → roughly one round-trip added, not 40. Keep the existing OpenAlex request budget untouched; the judge uses the OpenAI budget.

## 8. Test plan (`lib/relevance-judge.test.ts` + extend `scoring.test.ts`)

Inject a deterministic stub `JudgeFn` — never call OpenAI in tests (same as existing fetcher stubs).

1. **Keyword-collision filter:** paper with query terms in title but stub verdict `grade 0` → absent from `foundationalPapers`/`recentInfluencePapers`/clusters/people. The core regression test for the user's complaint.
2. **No-abstract retention:** `hasAbstract:false` → `judged:false`, retained, counted in `unjudgedNoAbstractCount`, not in `filteredOffTopicCount`.
3. **Disabled path = current behavior:** no key / judge throws → output byte-identical to today (lock the fallback).
4. **Blend math:** given fixed sub-scores + grade, assert `finalRelevanceScore` to fixed decimals; assert foundational/recent recompute.
5. **Determinism-given-cache:** two runs, same inputs → one underlying call, identical verdicts.
6. **Gating:** with 100 works, judge called on ≤40; assert call count and that gating uses pre-judge `finalRelevanceScore`.

## 9. Phased rollout

- **Phase 1:** module + injectable param + tests, behind `RELEVANCE_JUDGE` flag, **rerank only (no hard filter)** — compare distributions against current on real queries.
- **Phase 2:** enable hard filter on `grade 0` once false-positive removal rate is acceptable.
- **Phase 3 (later):** full-text fetcher (Unpaywall/landing page) implements the same `JudgeFn` input contract — no blend/pipeline changes needed. This is why the interface takes text, not "abstract," now.

## 10. Risks / limitations (state these in the PR)

- Judge miscalibration → a real paper filtered. Mitigated by ordinal scale, Phase-1 soft rollout, and only filtering `grade 0` (not 1).
- OpenAlex abstract coverage caps how many papers can actually be verified.
- "Deterministic" claim weakens to "deterministic given cache / when disabled" — update README.
- Abstract truncation can drop the contribution sentence; keep the budget generous and put title + topics first.
- Prompt edits must bump `PROMPT_VERSION` or stale verdicts persist in cache.

## 11. Optional adjacent cleanup (not required)

`compactText` (`scoring.ts:219`) concatenates keywords + topic labels, which inflates the embedding's lexical bias — the very thing causing leakage. Consider embedding **title + abstract only** and keeping topics/keywords as separate keyword-side signals. Cheap experiment, possibly meaningful even before the judge lands.
