import type { OpenAlexWork, ResearchMapRequest } from "./types";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const CACHE_TTL_MS = 60 * 60 * 1000;
const worksCache = new Map<string, { expiresAt: number; works: OpenAlexWork[] }>();
const SELECT_FIELDS = [
  "id",
  "doi",
  "display_name",
  "relevance_score",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "citation_normalized_percentile",
  "authorships",
  "primary_topic",
  "topics",
  "keywords",
  "type",
  "is_retracted",
  "abstract_inverted_index"
].join(",");

export function buildOpenAlexWorksUrl(request: ResearchMapRequest, perPage = 200): string {
  const url = new URL(OPENALEX_WORKS_URL);
  url.searchParams.set("search", request.topic);
  url.searchParams.set(
    "filter",
    [
      `from_publication_date:${request.fromYear}-01-01`,
      `to_publication_date:${request.toYear}-12-31`,
      "is_retracted:false"
    ].join(",")
  );
  url.searchParams.set("select", SELECT_FIELDS);
  url.searchParams.set("per-page", String(Math.min(Math.max(perPage, 30), 300)));
  url.searchParams.set("sort", "relevance_score:desc");
  return url.toString();
}

export async function fetchOpenAlexWorks(request: ResearchMapRequest): Promise<OpenAlexWork[]> {
  const cacheKey = normalizedCacheKey(request);
  const cached = worksCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.works;
  }

  const response = await fetch(buildOpenAlexWorksUrl(request), {
    headers: {
      Accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`OpenAlex request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { results?: OpenAlexWork[] };
  const works = payload.results ?? [];
  worksCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, works });
  return works;
}

function normalizedCacheKey(request: ResearchMapRequest): string {
  return [request.topic.trim().toLowerCase().replace(/\s+/g, " "), request.fromYear, request.toYear].join(":");
}
