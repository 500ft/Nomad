import type { CitationHistoryResult, CitationYear, OpenAlexWork, ResearchMapRequest } from "./types";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const CACHE_TTL_MS = 60 * 60 * 1000;
const worksCache = new Map<string, { expiresAt: number; works: OpenAlexWork[] }>();
const citationHistoryCache = new Map<string, { expiresAt: number; result: CitationHistoryResult }>();
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

export function normalizeOpenAlexWorkId(id: string): string {
  const trimmed = id.trim();
  const match = trimmed.match(/(?:openalex\.org\/)?(W\d+)$/i);
  return match?.[1].toUpperCase() ?? trimmed;
}

export function buildOpenAlexCitationHistoryUrl(workId: string): string {
  const url = new URL(OPENALEX_WORKS_URL);
  url.searchParams.set("filter", `cites:${normalizeOpenAlexWorkId(workId)}`);
  url.searchParams.set("group_by", "publication_year");
  url.searchParams.set("per-page", "200");
  return url.toString();
}

export async function fetchCitationHistoryForWorks(workIds: string[]): Promise<Map<string, CitationHistoryResult>> {
  const entries = await Promise.all(
    workIds.map(async (workId) => {
      const result = await fetchCitationHistoryForWork(workId);
      return [workId, result] as const;
    })
  );
  return new Map(entries);
}

export async function fetchCitationHistoryForWork(workId: string): Promise<CitationHistoryResult> {
  const normalizedId = normalizeOpenAlexWorkId(workId);
  const cached = citationHistoryCache.get(normalizedId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const response = await fetch(buildOpenAlexCitationHistoryUrl(normalizedId), {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`OpenAlex citation history request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OpenAlexGroupResponse;
    const result = buildCitationHistoryResult(payload.group_by ?? []);
    citationHistoryCache.set(normalizedId, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  } catch {
    const result: CitationHistoryResult = {
      status: "unavailable",
      history: null,
      note: "Citation history unavailable. Showing citations/year proxy instead."
    };
    citationHistoryCache.set(normalizedId, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  }
}

export function buildCitationHistoryResult(groups: OpenAlexGroup[]): CitationHistoryResult {
  const currentYear = new Date().getFullYear();
  const history: CitationYear[] = groups
    .map((group) => ({
      year: Number(group.key),
      citationCount: group.count,
      isPartialYear: Number(group.key) === currentYear
    }))
    .filter((item) => Number.isInteger(item.year) && item.year > 0 && item.citationCount > 0)
    .sort((a, b) => a.year - b.year);

  if (!history.length) {
    return {
      status: "unavailable",
      history: null,
      note: "Citation history unavailable. Showing citations/year proxy instead."
    };
  }

  return {
    status: "available",
    history,
    note: summarizeCitationHistory(history)
  };
}

function normalizedCacheKey(request: ResearchMapRequest): string {
  return [request.topic.trim().toLowerCase().replace(/\s+/g, " "), request.fromYear, request.toYear].join(":");
}

function summarizeCitationHistory(history: CitationYear[]): string {
  const completedYears = history.filter((item) => !item.isPartialYear);
  const previous = completedYears.at(-2);
  const latest = completedYears.at(-1);

  if (previous && latest) {
    if (latest.citationCount > previous.citationCount) {
      return `Yearly citing-work counts increased from ${previous.citationCount} in ${previous.year} to ${latest.citationCount} in ${latest.year}.`;
    }
    if (latest.citationCount < previous.citationCount) {
      return `Yearly citing-work counts decreased from ${previous.citationCount} in ${previous.year} to ${latest.citationCount} in ${latest.year}.`;
    }
    return `Yearly citing-work counts were steady at ${latest.citationCount} in ${previous.year} and ${latest.year}.`;
  }

  const first = history[0];
  const last = history.at(-1);
  if (first && last && first.year !== last.year) {
    return `OpenAlex found yearly citing-work counts from ${first.year} through ${last.year}.`;
  }
  return "OpenAlex found citation history for this paper, but there are not enough completed years to compare direction.";
}

type OpenAlexGroupResponse = {
  group_by?: OpenAlexGroup[];
};

export type OpenAlexGroup = {
  key: string | number;
  count: number;
};
