# Nomad

Nomad builds research starting maps for mechanical engineering project ideas using OpenAlex metadata.

The core workflow is simple:

```text
engineering topic in -> field-entry research map out
```

Nomad is not a broad paper discovery feed. It returns a focused report: what to read first, what has recent influence, who is active, what subtopics matter, citation signals, and possible project directions backed by evidence.

## Run

```bash
npm install --cache .npm-cache
npm run dev
```

Open http://localhost:3000.

## Verify

```bash
npm test
npm run build
```

## Semantic Ranking

Nomad can use OpenAI embeddings to improve relevance and clustering:

```bash
OPENAI_API_KEY=... npm run dev
```

If `OPENAI_API_KEY` is not set, the website still works and falls back to keyword, citation, and metadata scoring.

## OpenAlex polite pool

Set `OPENALEX_MAILTO` to a contact email to route OpenAlex requests through the
[polite pool](https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication#the-polite-pool):

```bash
OPENALEX_MAILTO=you@example.com npm run dev
```

It is optional; when unset, requests go through the default pool unchanged.

## MVP Scope

- Topic search
- Foundational paper ranking
- Recent-influence paper ranking
- People-of-interest ranking
- Topic clustering from OpenAlex topics and keywords
- Optional semantic relevance from OpenAI `text-embedding-3-small`
- Citation signals
- Evidence-backed project ideas
- Computed confidence, warnings, and data-quality metrics

V1 does not include accounts, saved reports, PDF export, embedding clustering, industry mapping, lab ranking, or research timelines.

## Status

**v2 active (bounded).** v1 shipped green and was briefly frozen; it is now
unfrozen for a deliberately small v2 focused on OpenAlex recall and a
deterministic evaluation harness. Tests (`npm test`) and the production build
(`npm run build`) stay green. See [`ROADMAP.md`](ROADMAP.md) for the v2 scope,
the explicit exclusions, and the superseded freeze decision.
