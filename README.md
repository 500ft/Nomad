# Nomad

Nomad is a Next.js research-mapping app that turns a mechanical-engineering topic
into a ranked starting map of papers, active researchers, subtopics, citation
signals, and evidence-backed project ideas.

Broad literature searches make it difficult to decide what to read first. Nomad
uses OpenAlex metadata, deterministic ranking, confidence checks, and optional
OpenAI embeddings to produce a focused field-entry report instead of a general
paper feed.

### Key capabilities

- Ranks foundational papers and recently influential work.
- Identifies active researchers, topics, keywords, and citation signals.
- Generates evidence-linked project directions with confidence and warnings.
- Works without an API key and adds semantic relevance when one is available.

**For:** mechanical-engineering students and researchers starting a literature
review or testing a project idea.

The core workflow is:

```text
engineering topic in -> field-entry research map out
```

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
