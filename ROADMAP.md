# Roadmap — Nomad

_Last updated: 2026-06-23 · Horizon: Summer 2026 (through ~2026-08-23)_

## Status: v1 SHIPPED — FROZEN

Nomad is the most complete and deployable project in the portfolio: a Next.js +
TypeScript research-mapping web app (OpenAlex metadata + optional OpenAI
embeddings), deployed on Vercel, with a real Vitest suite (73 passing) and a
green production build.

**Decision: this project is deliberately frozen at v1.** It has reached its
purpose — a working, shipped, full-stack tool. Further feature work is **not** a
good use of time given the current portfolio priorities (robotics/mechatronics
flagships), because Nomad is off-axis for those targets even though it is a
strong "I can ship production software" signal.

## What "frozen" means

Done this cycle:

- [x] Commit all pending working-tree changes (expanded scoring vocabulary,
      relevance judge, types, tests).
- [x] `npm test` green (73 passed, eval suite skipped without `OPENAI_API_KEY`).
- [x] `npm run build` green (typecheck + lint + production build).
- [x] README documents run/verify/scope.

Maintenance-only from here:

- Keep `main` building and tests green.
- Security/dependency bumps if flagged.
- Fix only user-blocking bugs.

## When to UN-freeze

Reopen feature work **only** if the career target shifts toward software /
full-stack roles. In that case Nomad becomes a primary portfolio piece and the
parked v2 ideas (accounts, saved reports, embedding clustering, lab ranking,
research timelines) are worth building. Until then: leave it shipped.

## Portfolio statement

> Designed, built, and deployed a full-stack research-mapping web application
> (Next.js/TypeScript, OpenAlex + OpenAI embeddings) with a tested ranking and
> clustering pipeline; used in my own research workflow.
