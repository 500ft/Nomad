# Nomad — Paper Choosing & Ranking Logic: Development Plan

**Scope:** the logic that decides which papers appear and in what order. Not UI polish, not project ideas.
**Status:** development plan / recommended sequencing. No code written.

---

## 0. Principles (the spine — every decision below follows from these)

1. **Choosing ≠ ranking.** "Is this paper *about* the query?" (eligibility, a gate) is a different question from "how much does it matter?" (importance, a ranking). Today they are fused into one blended scalar. Separate them.
2. **Relevance means aboutness, nothing else.** Citation strength must NOT live inside the relevance score. Citations enter only through importance terms. (See §1 — this is the single highest-leverage fix.)
3. **Every displayed number is attributable to its inputs.** Scores are linear blends, so each contribution is exactly computable. Explanations are *derived from the math*, never hand-written.
4. **Deterministic core; LLM only at the eligibility gate.** Ranking stays reproducible arithmetic. The only model-sourced fields are the eligibility grade and the one-line "about". Label them as such.
5. **Measure before you tune or delete.** No weight change and no paper-deletion ships without a labeled eval set to measure it against.

---

## 1. The contamination problem (fix first, it's cheap and high-impact)

**Symptom:** highly-cited off-topic papers rank well.
**Root cause (in code):**

```
blendRelevance   = 0.45·keyword + 0.35·semantic + 0.20·citationPercentile   // embeddings.ts:48
foundationalScore= 0.40·logCit  + 0.25·citationPct + 0.25·finalRelevance + 0.10·source
recentInfluence  = 0.30·citPerYr + 0.25·recency   + 0.30·finalRelevance + 0.15·citationPct
```

Citations enter `foundationalScore` three ways (log count, percentile, and again *inside* `finalRelevance`). Effective weights ≈ citations 0.70 / aboutness 0.20. Relevance is diluted by the very thing it should be independent of.

**Fix:**
- Strip `citationPercentile` out of `blendRelevance`. Relevance = aboutness only:
  - judge available → `0.55·judge + 0.30·keyword + 0.15·semantic`
  - judge unavailable → `0.65·keyword + 0.35·semantic`
- Leave citations to the importance formulas where they belong. Renormalize the freed 0.20 weight (e.g. foundational becomes `0.40·logCit + 0.30·citationPct + 0.20·relevance + 0.10·source` — tune on eval).

This alone meaningfully reduces leakage *before* the judge exists, and it makes the "relevance" axis mean what users think it means.

---

## 2. Target pipeline (stages with clear contracts)

```
Stage 0  Retrieval            OpenAlex query → candidate works
Stage 1  Normalize + validity retracted/year/dedupe/title  → NormalizedWork[]
Stage 2  ELIGIBILITY gate     cheap pre-gate (keyword+semantic) → top-K → LLM judge → grade 0-3
                              grade 0 = ineligible (removed); no-abstract = unverified (retained, capped)
Stage 3  IMPORTANCE ranking   on eligible set only; deterministic facets (below)
Stage 4  Reasoning ledger     derived from Stage 2-3 math (PaperReasoning)
Stage 5  Section assembly     Start Here / Watch Now / clusters / people / projects on the SAME eligible set
```

**Critical ordering rule:** the eligibility filter must run *before* citation-network seed selection, clustering, people, and project ideas. Currently the network is seeded from `scored` (`scoring.ts:104–122`) before any filter — so an off-topic paper can still seed the graph and inject shared-reference "evidence." One filtered set must feed everything downstream.

### Stage 3 importance is multi-faceted, not one number

Each facet is a linear blend ⇒ fully attributable:

- **Foundational** = citation mass + global percentile + relevance + source (+ graph support).
- **Recent influence** = citations/year + recency + relevance + percentile.
- **Network** = `graphSupportScore` (shared-reference connectivity to seeds).
- **Cluster representativeness** = is the paper in its cluster's top-by-recent-influence set.

A paper's "why it appears" is the *named top contributors of the facet that placed it*, not a generic label.

---

## 3. Phased delivery

### Phase 0 — Evaluation harness + golden set  *(prerequisite, blocks everything that deletes or reweights)*
- Hand-label ~5–8 representative queries × top ~20 papers: `core / relevant / tangential / off-topic`.
- Commit as fixtures. Build a one-command harness reporting **precision@10, false-drop rate (real papers filtered), and rank correlation** against current `main`.
- Exit: harness runs in CI; current baseline numbers recorded.
- *Why first:* Phases 2–4 either delete papers or change weights. Without this you cannot tell improvement from regression. This gap has been the recurring hole in every prior plan.

### Phase 1 — De-contaminate + honest ledger  *(pure refactor, no deletion, low risk)*
- Apply §1 relevance/importance reweighting.
- Add `ScoreContribution` + deterministic contribution builders for foundational, recent-influence, and relevance blends.
- **Include `graphSupportScore` as a foundational driver** — the real rank is `foundationalScore + graphSupportScore` (`scoring.ts:128`); a ledger that omits it will mis-explain every graph-boosted paper. `importance.score` must equal the actual ranking score, and drivers must sum to it.
- Replace hardcoded `["high-citation-signal","topic-relevant"]` / `["recent-influence-proxy","topic-relevant"]` with codes derived from top contributions + centralized thresholds.
- Fix percentile inconsistency: prefer OpenAlex **global** normalized percentile, fall back to local `localPercentile` only when absent, and record which was used (mixing global and query-local percentiles in one formula is currently silent).
- Exit: contribution totals equal the displayed ranking score (incl. graph); eval numbers move no worse than baseline; paper `reasonCodes` are now true (no test asserts the old codes, so migration risk is low).

### Phase 2 — Eligibility gate (rerank-only first)  *(LLM enters here)*
- `lib/relevance-judge.ts`: gate to top-40 by first-stage relevance, batch 8/call, ordinal grade 0–3, structured JSON output, `temperature:0` + fixed seed.
- Cache keyed on `hash(workId + abstractHash + query + model + PROMPT_VERSION)`; in-memory like `embeddingCache`. Deterministic-given-cache; document the caveat and amend the README's "deterministic" claim.
- Injectable `JudgeFn` parameter on `buildResearchMap` (same pattern as `citationHistoryFetcher`) so tests never hit the network.
- No-abstract → retained, `unverified-no-abstract`, capped (cannot rank as core).
- **Run in rerank-only mode** (judge feeds the relevance term; no deletion yet). Measure on the Phase 0 harness.
- Exit: judge improves precision@10 on the eval set with acceptable false-drop *risk* before any hard filter is enabled.

### Phase 3 — Hard filter + downstream re-ordering
- Enable `grade 0` removal **before** network-seed selection, clustering, people, and projects (the ordering rule in §2).
- Add `excludedPapers` diagnostics (id, title, grade, reason) — the why-NOT ledger.
- Re-baseline `computeMapConfidence` / `queryFocus`: filtering shrinks `usableWorks`, so confidence will legitimately drop. That is correct on a cleaner set — re-tune thresholds, don't loosen the filter to chase the old numbers.
- Exit: off-topic regression queries are clean; eval false-drop rate within agreed bound.

### Phase 4 — Ranking-quality refinements  *(iterative, optional, eval-gated)*
- **Diversity / redundancy control:** top lists can be dominated by one lab/cluster. Add an MMR-style penalty or per-cluster cap so Start Here/Watch Now span the field.
- **Citations/year shrinkage:** 1–2-year-old papers have a tiny denominator and produce flukes in Watch Now. Add a minimum-age guard or Bayesian shrinkage toward the field mean.
- **Recency on an absolute scale:** `recencyScore` is normalized by the user's `fromYear/toYear` window, so it isn't comparable across queries. Switch to age-since-publication with a fixed half-life.
- Each change ships only if it improves the eval numbers.

### Phase 5 — Surface the reasoning
- `lib/derive/explain.ts` (exists) + paper cards render from `paper.reasoning`: Start Here explains foundational drivers, Watch Now explains recent-influence drivers, caveats show no-abstract / unverified / low-relevance / no-citation-history.
- Label `eligibility.about` as model-generated; keep it out of anything called "deterministic."

---

## 4. Cross-cutting

- **Weights are config, not magic constants.** Centralize all weights + thresholds; document the rationale; let the eval harness justify them. Today they are unvalidated hand-tuned numbers.
- **Determinism boundary is explicit:** Stages 1, 3, 4 fully deterministic; Stage 2 grade/about are the only LLM outputs; cache makes them reproducible-given-cache.
- **Observability:** `RelevanceJudgeSignals` (judged/filtered/unverified/failed counts) + `excludedPapers` in the response so every run is auditable.

## 5. Open decisions worth your call
- Exact post-decontamination weights (start from §1, finalize on eval).
- False-drop tolerance that gates Phase 2→3 (e.g. "≤1 real paper dropped per 100 judged").
- Whether diversity control (Phase 4) applies to Start Here, Watch Now, or both.

## 6. Sequencing rationale (one line)
Eval first so you can see; de-contaminate the math so the deterministic core is already honest; *then* add the LLM gate on top of a clean base — so when off-topic papers finally disappear, you can prove it and explain every paper that remains.
