# Roadmap — Nomad

_Last updated: 2026-06-25 · Horizon: Summer 2026 (through ~2026-08-23)_

## Status: v2 — ACTIVE

Nomad v1 shipped green (Next.js + TypeScript research-mapping web app, OpenAlex
metadata + optional OpenAI embeddings, deployed on Vercel, real Vitest suite,
green production build). It was frozen at v1; **as of 2026-06-25 it is unfrozen
for a bounded v2** (see the superseded freeze decision below).

**v2 is deliberately small.** Nomad is still off-axis for the portfolio's
robotics/mechatronics flagships, so v2 is _not_ a feature land-grab. It is a
short, high-leverage pass that makes the core retrieval and ranking measurably
better and measurable at all — picked from the previously parked list, with
explicit "not now" exclusions to keep it bounded.

## v2 MVP scope

Highest-leverage items only. Everything else stays parked.

- [x] **OpenAlex recall (no key).** `fetchOpenAlexWorks` issued a single
      query/page. v2 issues multiple query variants (verbatim topic +
      field-scoped + core-terms) and dedupes results by normalized work id, so
      relevant-but-lower-ranked papers surface instead of being truncated off
      one page. Adds a polite-pool `mailto` param (`OPENALEX_MAILTO`) on every
      OpenAlex request. Covered by `lib/openalex.test.ts` (variant dedupe +
      mailto), no API key required.
- [x] **Eval fixtures scaffolding (no key).** `lib/quality/eval.test.ts` reads
      hand-labeled captures from `test-fixtures/openalex/*.json`
      (`{ request, capturedAt, works }`). Two example fixtures land now
      (`battery-thermal`, `soft-robotics`); adding a slug activates its checks
      instantly. This is the deterministic harness — it needs no key.
- [ ] **Real eval numbers (gated on `OPENAI_API_KEY`).** With the deterministic
      harness in place, wire precision@10 / false-drop reporting for the
      embeddings + relevance-judge path. **Blocked on the key** (user-provided,
      out of scope for the keyless prep). Run with
      `OPENAI_API_KEY=... RELEVANCE_JUDGE=1` — see the header comment in
      `eval.test.ts`.
- [ ] **Embedding clustering.** Replace topic/keyword-string clusters with
      embedding-space clustering for the same eligible set. Gated on
      `OPENAI_API_KEY` and on the eval harness showing it beats the current
      TF-IDF subcluster split. Only ships if the numbers move.

### Explicitly NOT in v2 (still parked)

Accounts, saved reports, PDF export, industry mapping, lab ranking, research
timelines. These reopen only under the career-shift condition below.

### v2 exit criteria

- Recall additions + eval fixtures are committed, `npm test` green (73 baseline
  + new tests), `npm run build` green. **(met)**
- Real eval numbers recorded once a key is available; embedding clustering ships
  only if it beats baseline on those numbers.

## Superseded decision — v1 FROZEN (2026-06-23)

> Kept for history; superseded by the v2 unfreeze above.

Nomad reached its purpose at v1 — a working, shipped, full-stack tool — and was
frozen because further feature work was judged off-axis for the portfolio's
robotics/mechatronics targets. "Frozen" meant: keep `main` building and tests
green, take security/dependency bumps, fix only user-blocking bugs. The unfreeze
above is a deliberately bounded exception, not a return to open-ended feature
work.

Done in the v1 freeze cycle:

- [x] Commit all pending working-tree changes (expanded scoring vocabulary,
      relevance judge, types, tests).
- [x] `npm test` green (73 passed, eval suite skipped without fixtures).
- [x] `npm run build` green (typecheck + lint + production build).
- [x] README documents run/verify/scope.

## When to expand BEYOND the bounded v2

Reopen the fully parked list (accounts, saved reports, embedding clustering at
scale, lab ranking, research timelines) **only** if the career target shifts
toward software / full-stack roles. In that case Nomad becomes a primary
portfolio piece and that work is worth building. Until then: ship the bounded
v2 and stop.

## Portfolio statement

> Designed, built, and deployed a full-stack research-mapping web application
> (Next.js/TypeScript, OpenAlex + OpenAI embeddings) with a tested ranking and
> clustering pipeline, a deterministic evaluation harness, and multi-query
> OpenAlex retrieval; used in my own research workflow.
