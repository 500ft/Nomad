# Evaluation results

Nomad currently has strong unit and regression coverage for deterministic
ranking components, but limited topic-level fixture coverage. This page records
what the automated suite tests and what remains unevaluated.

## Current automated run

Command:

```bash
npm test -- --reporter=verbose
```

Run on 2026-08-05:

| Metric | Result |
| --- | ---: |
| Test files | 9 passed |
| Tests | 88 passed |
| Failed tests | 0 |
| Topic fixtures present | 2 of 5 named audit topics |

The suite covers query-variant construction, OpenAlex normalization,
deduplication, relevance diagnostics, scoring, project-idea constraints,
citation-history handling, shared-reference graph support, query focus,
subclustering, roadmaps, trend calculations, and response construction.

## Topic-level regression fixtures

The evaluation harness defines five audit topics in
`lib/quality/eval.test.ts`, but only two frozen OpenAlex captures currently
exist.

| Audit topic | Fixture | Active assertion |
| --- | --- | --- |
| Battery thermal management | Present | A dominant cluster must split into at least two subclusters |
| Soft robotics | Present | Foundational picks must retain at least one named canonical paper family |
| AI in mechanical design | Missing | Hospitality and marketing drift rejection is not exercised |
| Additive-manufacturing defects | Missing | On-topic foundational-pick ratio is not exercised |
| 6G channel modeling | Missing | Channel/RIS/terahertz foundational-pick ratio is not exercised |

The three missing-fixture tests return before their topic assertion. Vitest
therefore reports them as passed even though they do not evaluate a captured
result set. The cross-topic rejection sanity check currently processes the two
available fixtures.

## What these results support

- Deterministic transformations and scoring rules behave as encoded across the
  committed unit cases.
- The two captured topics satisfy their current regression invariants.
- Frozen fixtures make those checks repeatable without live OpenAlex changes.

## What they do not establish

- Precision, recall, or ranking quality across mechanical-engineering fields.
- Superiority over OpenAlex search, Google Scholar, Connected Papers, or another
  literature tool.
- Stability of live results as OpenAlex records and citation counts change.
- The quality of optional embedding or LLM relevance paths.
- Whether researchers complete literature reviews faster or choose better
  papers with Nomad.
- Graph readability, accessibility, or usability at different result-set sizes.

## Next evaluation work

1. Capture and review the three missing audit-topic fixtures.
2. Add paper-level relevance labels and report precision at fixed result counts.
3. Add ranking comparisons against a simple OpenAlex relevance baseline.
4. Add graph-size and visual-overlap tests for small, typical, and dense maps.
5. Run a small user study measuring paper-selection time and correction rate.

Fixture format and activation behavior are documented in
[`lib/quality/eval.test.ts`](../lib/quality/eval.test.ts). Data and runtime
visual production are described in [`data-and-figures.md`](data-and-figures.md).
