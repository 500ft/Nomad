# Contributing

## Development setup

Use a current Node.js LTS release:

```bash
npm ci
npm run dev
```

## Quality checks

Run the same checks as CI before submitting a change:

```bash
npm run lint
npm test
npm run build
```

## Data and ranking changes

- Keep network-independent fixtures for ranking and query-focus tests.
- Treat OpenAlex IDs as stable identifiers; do not deduplicate only by title.
- Keep deterministic scoring available when no OpenAI key is configured.
- Add or update tests when changing weights, filters, query variants, or warning
  thresholds.
- Expose new scoring signals in the result metadata or documentation.

## Interface changes

- Preserve keyboard access and visible labels for form controls.
- Test narrow and wide layouts.
- Keep warnings and data-quality information near the results they qualify.
- Do not display an external API key or place it in a `NEXT_PUBLIC_` variable.

## Pull requests

Describe the user-facing change, list the test fixtures affected, and include a
screenshot for visual changes when a browser is available.
