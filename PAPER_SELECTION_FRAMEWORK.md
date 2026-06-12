# Nomad — Paper Selection Decision Framework (v2)

**Scope:** the decision policy for which papers are picked, retained, ranked, and displayed.
**Relation to other docs:** `PAPER_RANKING_DEV_PLAN.md` is the *sequencing* plan. This document is the *decision framework* it implements — the rules, contracts, and invariants. If the two conflict, this document wins on "what"; the dev plan wins on "when".

---

## 1. The core decision model: Gate → Score → Select → Explain

Every paper passes through four distinct decisions. Each decision answers exactly one question and is forbidden from answering the others.

| Stage | Question | Allowed inputs | Forbidden inputs |
|---|---|---|---|
| **GATE** (eligibility) | Is this paper about the query? | keyword overlap, semantic similarity, LLM judge grade | citations, venue, recency, authors |
| **SCORE** (importance) | Among eligible papers, how much does it matter? | citations, percentile, citations/yr, recency, source quality, graph support, relevance | nothing from ineligible papers |
| **SELECT** (assembly) | Which scored papers fill each section? | facet scores, diversity constraints, section quotas | raw blended scalars without facet attribution |
| **EXPLAIN** (ledger) | Why is this paper here (or not here)? | the actual numbers from GATE and SCORE | hand-written labels, hardcoded reason codes |

The current system fuses GATE and SCORE into one blended scalar. That is the root defect: `0.20 · citationPercentile` inside `blendRelevance` (`embeddings.ts:48`) lets citation mass buy aboutness. Combined with `0.25 · finalRelevance` inside `foundationalScore`, citations enter the foundational ranking three times — effective weight ≈ 0.70 citations vs ≈ 0.20 aboutness. A famous off-topic paper beats an on-topic average one. Separating the gate from the score eliminates the failure class, not just the symptom.

## 2. Stage contracts

### 2.1 GATE — eligibility

```
aboutness (judge available)  = 0.55·judgeGrade/3 + 0.30·keyword + 0.15·semantic
aboutness (no judge)         = 0.65·keyword + 0.35·semantic
```

- Judge grades: 0 off-topic · 1 tangential · 2 relevant · 3 core. Ordinal, temperature 0, fixed prompt version, cached on `hash(workId + abstractHash + query + model + PROMPT_VERSION)`.
- Grade 0 ⇒ removed before *anything* downstream: network seeds, clusters, people, projects. One filtered set feeds everything. (Today seeds are drawn from `scored` pre-filter, `scoring.ts:104–122` — an off-topic paper can inject shared-reference "evidence." This is the single most important ordering rule.)
- No abstract ⇒ `unverified-no-abstract`: retained, capped (cannot rank as core), flagged in the ledger. Never silently treated as relevant.
- Judge is gated to top-K (≈40) by cheap pre-score; everything below K is eligible-by-default but capped below judged papers. This bounds LLM cost without letting the judge's absence delete papers.

**Invariant G1:** no citation-derived quantity appears in any aboutness formula.
**Invariant G2:** removal happens at exactly one point in the pipeline, and every removal writes an `excludedPapers` entry (id, title, grade, reason).

### 2.2 SCORE — importance facets

Importance is a set of named facets, not one number. Each facet is a linear blend, so every contribution is exactly attributable.

```
foundational    = 0.40·logCitations + 0.30·citationPctile + 0.20·aboutness + 0.10·sourceQuality
rankFoundational= clamp01(foundational + graphSupport)        // graph support is part of the score, so it is part of the explanation
recentInfluence = 0.30·citPerYear(shrunk) + 0.25·recencyAbs + 0.30·aboutness + 0.15·citationPctile
network         = graphSupportScore (shared-reference connectivity to seeds)
```

Required corrections to facet inputs:

- **Citations/year shrinkage.** `citPerYear` for papers < 2 years old is a tiny-denominator fluke generator. Use Bayesian shrinkage toward the field mean (or a minimum-age guard) before it enters recentInfluence.
- **Absolute recency.** `recencyScore` is currently normalized to the user's year window, so the same paper gets different recency in different searches. Replace with age-since-publication under a fixed half-life.
- **One percentile, recorded.** Prefer OpenAlex global percentile; fall back to local percentile only when absent, and record which was used. Never mix the two silently in one formula.

**Invariant S1:** aboutness appears in importance facets only as a *tiebreaker-weight* term (≤ 0.30), never the dominant term — the gate already handled eligibility.
**Invariant S2:** the displayed score equals the ranking score. If graph support moves rank, it appears in the ledger with its numeric contribution.

### 2.3 SELECT — section assembly

- Start Here = top-N by `rankFoundational`; Watch Now = top-N by `recentInfluence`; both drawn from the same post-gate set.
- **Diversity constraint:** apply an MMR-style penalty or per-cluster cap so one lab or subfield cannot fill a section. A correct ranking that shows five near-duplicates is a failed selection.
- Section quotas are not targets to fill. If only three papers clear the bar, show three. Empty slots are honest; padded slots are not.

### 2.4 EXPLAIN — the reasoning ledger

For every displayed paper: the facet that placed it, its top contributing terms *with values*, and its caveats (`unverified-no-abstract`, `low-relevance-capped`, `graph-boosted`, `judge-unavailable`). For every removed paper: the why-NOT entry. Reason codes are derived from the top contributions — the hardcoded `["high-citation-signal","topic-relevant"]` labels are deleted, not migrated.

**Invariant E1:** every explanation is computed from the same numbers that produced the rank. If you cannot derive the sentence from the math, the sentence is wrong.

## 3. Decision table (operational summary)

| Condition | Decision |
|---|---|
| Retracted, out-of-window, duplicate | Drop at normalization (pre-gate) |
| Judge grade 0 | Remove; write `excludedPapers` entry |
| Judge grade 1 | Eligible; capped out of "core" placements |
| Judge grade 2–3 | Eligible; full ranking |
| No abstract | Eligible; `unverified` cap + ledger caveat |
| Judge unavailable / call failed | Eligible by pre-score; ledger marks `judge-unavailable`; never delete on infrastructure failure |
| Below top-K pre-score | Eligible-by-default, ranked below judged set |

The last two rows encode the framework's failure-safety rule: **the LLM may only ever remove papers, and only with an affirmative grade of 0. Absence of a judgment never deletes a paper.**

## 4. What makes this framework defensible

1. **Single point of removal** — auditability. One `excludedPapers` list answers every "where did paper X go?"
2. **Deterministic core, bounded LLM** — the only model-sourced fields are the grade and a one-line "about", both labeled, both cached. Rankings are reproducible-given-cache.
3. **Eval-gated changes** — no weight change, no filter, no judge ships without the Phase-0 harness (precision@10, false-drop rate, rank correlation on hand-labeled fixtures). The weights above are starting points, not conclusions; the harness finalizes them.
4. **Honest by construction** — explanations derive from the math, confidence is allowed to drop when the set shrinks (re-tune thresholds; do not loosen the filter to chase old numbers), and "distinctiveness ≠ novelty" stays a stated limit.

## 5. Acceptance criteria (definition of done)

- [ ] No citation term in any relevance/aboutness computation (grep-verifiable).
- [ ] Network seeds, clusters, people, and projects all consume the post-gate set.
- [ ] `Σ ledger contributions = displayed score` for every paper, including graph support.
- [ ] `excludedPapers` present in the API response; UI can render why-NOT.
- [ ] Eval harness in CI; baseline recorded; false-drop rate within agreed bound (proposal: ≤ 1 real paper per 100 judged).
- [ ] CitPerYear shrinkage + absolute recency + single-percentile rule implemented and noted in ledger.
- [ ] Section assembly enforces a diversity constraint and never pads to quota.
