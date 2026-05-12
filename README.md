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

## MVP Scope

- Topic search
- Foundational paper ranking
- Recent-influence paper ranking
- People-of-interest ranking
- Topic clustering from OpenAlex topics and keywords
- Citation signals
- Evidence-backed project ideas
- Computed confidence, warnings, and data-quality metrics

V1 does not include accounts, saved reports, PDF export, embedding clustering, industry mapping, lab ranking, or research timelines.
