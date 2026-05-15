import { describe, expect, it } from "vitest";

import {
  buildCitationHistoryFromCountsByYear,
  buildCitationHistoryResult,
  buildOpenAlexCitationHistoryUrl,
  buildOpenAlexWorksByIdsUrl,
  buildOpenAlexWorksUrl,
  normalizeOpenAlexWorkId
} from "./openalex";
import { blendRelevance, cosineSimilarity } from "./embeddings";
import {
  buildCompactText,
  buildResearchDirectionSummary,
  buildResearchMap,
  calculateGraphSupportScore,
  calculateDirectionMomentumScore,
  computeMapConfidence,
  getLowerActivityConfidence,
  normalizeWorks,
  passesSharedReferenceRelevanceGate,
  reconstructAbstract,
  scoreWorks
} from "./scoring";
import type { CitationHistoryResult, OpenAlexWork, ResearchMapRequest, TopicCluster } from "./types";

const request: ResearchMapRequest = {
  topic: "machine learning for HVAC CFD",
  experienceLevel: "beginner",
  goal: "build-project",
  fromYear: 2020,
  toYear: 2026
};

function work(id: string, overrides: Partial<OpenAlexWork> = {}): OpenAlexWork {
  return {
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/10.1234/${id}`,
    display_name: `Machine learning HVAC CFD study ${id}`,
    publication_year: 2024,
    publication_date: "2024-01-01",
    relevance_score: 80,
    cited_by_count: 25,
    citation_normalized_percentile: { value: 0.7 },
    authorships: [
      {
        author: {
          id: "https://openalex.org/A1",
          display_name: "Ada Researcher"
        }
      }
    ],
    primary_topic: {
      id: "https://openalex.org/T1",
      display_name: "Building airflow simulation"
    },
    topics: [
      {
        id: "https://openalex.org/T2",
        display_name: "Computational fluid dynamics"
      }
    ],
    keywords: [{ display_name: "HVAC" }],
    type: "article",
    is_retracted: false,
    abstract_inverted_index: { machine: [0], learning: [1] },
    ...overrides
  };
}

async function unavailableCitationHistory(workIds: string[]): Promise<Map<string, CitationHistoryResult>> {
  return new Map(
    workIds.map((workId) => [
      workId,
      {
        status: "unavailable",
        history: null,
        source: null,
        note: "Citation history unavailable. Showing citations/year proxy instead."
      }
    ])
  );
}

describe("OpenAlex query construction", () => {
  it("filters upstream and selects explicit fields", () => {
    const url = buildOpenAlexWorksUrl(request);

    expect(url).toContain("search=machine+learning+for+HVAC+CFD");
    expect(url).toContain("from_publication_date%3A2020-01-01");
    expect(url).toContain("to_publication_date%3A2026-12-31");
    expect(url).toContain("is_retracted%3Afalse");
    expect(url).toContain("select=");
    expect(url).toContain("per-page=200");
  });

  it("builds citation history URLs from short and full OpenAlex work IDs", () => {
    expect(normalizeOpenAlexWorkId("https://openalex.org/W123")).toBe("W123");
    expect(normalizeOpenAlexWorkId("W456")).toBe("W456");

    const url = buildOpenAlexCitationHistoryUrl("https://openalex.org/W123");
    expect(url).toContain("filter=cites%3AW123");
    expect(url).toContain("group_by=publication_year");
  });

  it("builds chunkable OpenAlex ID filter URLs for shared references", () => {
    const url = buildOpenAlexWorksByIdsUrl(["https://openalex.org/W123", "W456"]);

    expect(url).toContain("ids.openalex%3AW123%7CW456");
    expect(url).toContain("select=");
  });
});

describe("normalization and scoring", () => {
  it("deduplicates by DOI and excludes retracted works", () => {
    const works = [
      work("W1"),
      work("W2", { doi: "https://doi.org/10.1234/W1" }),
      work("W3", { is_retracted: true })
    ];

    const result = normalizeWorks(request, works);

    expect(result.works).toHaveLength(1);
    expect(result.dedupedCount).toBe(1);
    expect(result.excludedRetractedCount).toBe(1);
  });

  it("normalizes scores to 0-1 before ranking", () => {
    const scored = scoreWorks(request, [
      ...normalizeWorks(request, [
        work("W1", { cited_by_count: 5000, publication_year: 2020 }),
        work("W2", { cited_by_count: 10, publication_year: 2026 })
      ]).works
    ]);

    for (const item of scored) {
      expect(item.logCitationScore).toBeGreaterThanOrEqual(0);
      expect(item.logCitationScore).toBeLessThanOrEqual(1);
      expect(item.foundationalScore).toBeGreaterThanOrEqual(0);
      expect(item.foundationalScore).toBeLessThanOrEqual(1);
      expect(item.recentInfluenceScore).toBeGreaterThanOrEqual(0);
      expect(item.recentInfluenceScore).toBeLessThanOrEqual(1);
    }
  });

  it("uses computed confidence thresholds", () => {
    expect(computeMapConfidence(75, 0.55)).toBe("strong");
    expect(computeMapConfidence(25, 0.2)).toBe("moderate");
    expect(computeMapConfidence(24, 0.9)).toBe("sparse");
  });

  it("maps citation_normalized_percentile through the value field only", () => {
    const normalized = normalizeWorks(request, [
      work("W-percentile", {
        citation_normalized_percentile: {
          value: 0.91,
          is_in_top_1_percent: false,
          is_in_top_10_percent: true
        }
      })
    ]).works[0];

    expect(normalized.citationPercentileValue).toBe(0.91);
    expect(scoreWorks(request, [normalized])[0].citationPercentileScore).toBe(0.91);
  });
});

describe("research map output", () => {
  it("returns the six sections and traceable project ideas", async () => {
    const works = Array.from({ length: 35 }, (_, index) =>
      work(`W${index}`, {
        display_name: `Machine learning HVAC CFD paper ${index}`,
        cited_by_count: 10 + index,
        publication_year: 2020 + (index % 6),
        authorships: [
          {
            author: {
              id: index % 2 ? "https://openalex.org/A1" : "https://openalex.org/A2",
              display_name: index % 2 ? "Ada Researcher" : "Grace Engineer"
            }
          }
        ],
        primary_topic: {
          id: index % 2 ? "https://openalex.org/T1" : "https://openalex.org/T2",
          display_name: index % 2 ? "Building airflow simulation" : "Reduced order modeling"
        }
      })
    );

    const map = await buildResearchMap(request, works, unavailableCitationHistory);

    expect(map.foundationalPapers).toHaveLength(5);
    expect(map.recentInfluencePapers).toHaveLength(5);
    expect(map.people.length).toBeGreaterThan(0);
    expect(map.people.length).toBeLessThanOrEqual(5);
    expect(map.clusters.length).toBeGreaterThan(0);
    expect(map.clusters.length).toBeLessThanOrEqual(6);
    expect(map.citationSignals.totalUsableWorks).toBeGreaterThan(0);
    expect(map.citationSignals.topClusterByPaperCount).toBeTruthy();
    expect(map.researchDirectionSummary.briefSummary).toContain("result set");
    expect(map.semanticSignals.enabled).toBe(false);
    expect(map.warnings).toContain("Semantic ranking unavailable; using keyword and citation scoring only.");
    expect(map.projectIdeas.length).toBeGreaterThan(0);
    expect(map.evidence.length).toBeGreaterThan(0);
    expect(map.query.field).toBe("mechanical engineering");
    expect(map.projectIdeas[0].supportingPaperIds.length).toBeGreaterThan(0);
    expect(map.projectIdeas[0].supportingClusterIds.length).toBeGreaterThan(0);
    expect(map.projectIdeas[0].reasonCodes.length).toBeGreaterThan(0);
    expect(map.projectIdeas[0].traceability.supportingPaperIds.length).toBeGreaterThan(0);
    expect(map.projectIdeas[0].traceability.limitations.length).toBeGreaterThan(0);
    expect(map.citationNetworkSignals.requestBudgetUsed).toBeLessThanOrEqual(7);
    expect(map.people[0].id).toContain("https://openalex.org/A");
    expect(map.recentInfluencePapers[0].citationHistoryStatus).toBe("unavailable");
    expect(map.recentInfluencePapers[0].citationHistoryNote).toContain("citations/year proxy");
  });

  it("builds a usable map from named test papers", async () => {
    const testPapers: OpenAlexWork[] = [
      work("W-foundation", {
        display_name: "Reduced-order modeling for HVAC airflow simulation",
        publication_year: 2020,
        cited_by_count: 220,
        primary_topic: {
          id: "https://openalex.org/T-hvac",
          display_name: "HVAC airflow modeling"
        }
      }),
      work("W-recent", {
        display_name: "Physics-informed neural networks for indoor airflow prediction",
        publication_year: 2026,
        cited_by_count: 48,
        primary_topic: {
          id: "https://openalex.org/T-pinn",
          display_name: "Physics-informed machine learning"
        }
      }),
      work("W-project", {
        display_name: "Machine learning surrogates for fast CFD design iteration",
        publication_year: 2025,
        cited_by_count: 64,
        primary_topic: {
          id: "https://openalex.org/T-surrogate",
          display_name: "CFD surrogate modeling"
        }
      }),
      ...Array.from({ length: 30 }, (_, index) =>
        work(`W-test-${index}`, {
          display_name: `Mechanical engineering test paper ${index} for HVAC CFD research maps`,
          publication_year: 2021 + (index % 5),
          cited_by_count: 8 + index,
          primary_topic: {
            id: index % 2 ? "https://openalex.org/T-hvac" : "https://openalex.org/T-surrogate",
            display_name: index % 2 ? "HVAC airflow modeling" : "CFD surrogate modeling"
          }
        })
      )
    ];

    const map = await buildResearchMap({ ...request, field: "mechanical engineering" }, testPapers, unavailableCitationHistory);

    expect(map.foundationalPapers.some((paper) => paper.title.includes("Reduced-order modeling"))).toBe(true);
    expect(map.recentInfluencePapers.some((paper) => paper.title.includes("Physics-informed"))).toBe(true);
    expect(map.citationSignals.totalUsableWorks).toBe(33);
    expect(map.clusters.map((cluster) => cluster.label)).toContain("HVAC airflow modeling");
    expect(map.projectIdeas.every((idea) => idea.supportingPaperIds.length > 0)).toBe(true);
  });
});

describe("citation history", () => {
  it("converts grouped OpenAlex citation counts into sorted yearly history", () => {
    const result = buildCitationHistoryResult([
      { key: 2024, count: 15 },
      { key: 2022, count: 3 },
      { key: 2023, count: 9 }
    ]);

    expect(result.status).toBe("available");
    expect(result.history?.map((item) => item.year)).toEqual([2022, 2023, 2024]);
    expect(result.history?.map((item) => item.citationCount)).toEqual([3, 9, 15]);
    expect(result.note).toContain("increased");
  });

  it("marks the current year as partial", () => {
    const currentYear = new Date().getFullYear();
    const result = buildCitationHistoryResult([{ key: currentYear, count: 5 }]);

    expect(result.history?.[0]).toMatchObject({ year: currentYear, isPartialYear: true });
  });

  it("returns unavailable citation history for empty grouped responses", () => {
    const result = buildCitationHistoryResult([]);

    expect(result.status).toBe("unavailable");
    expect(result.history).toBeNull();
    expect(result.note).toContain("citations/year proxy");
  });

  it("zero-fills missing counts_by_year values inside the recent OpenAlex window", () => {
    const currentYear = new Date().getFullYear();
    const result = buildCitationHistoryFromCountsByYear([
      { year: currentYear - 2, cited_by_count: 8 },
      { year: currentYear, cited_by_count: 3 }
    ]);

    expect(result.status).toBe("available");
    expect(result.source).toBe("openalex-counts-by-year");
    expect(result.history).toHaveLength(10);
    expect(result.history?.find((item) => item.year === currentYear - 1)?.citationCount).toBe(0);
    expect(result.history?.find((item) => item.year === currentYear)?.isPartialYear).toBe(true);
    expect(result.note).toContain("Recent yearly citations from OpenAlex");
  });
});

describe("citation graph", () => {
  it("caps graph support on the 0-1 score scale", () => {
    expect(
      calculateGraphSupportScore({
        sharedReferenceHit: true,
        seedReferenceFrequencyNormalized: 1,
        topicOverlapHit: true,
        citationPercentileHit: true
      })
    ).toBeLessThanOrEqual(0.05);
  });

  it("uses deterministic relevance gate thresholds", () => {
    expect(
      passesSharedReferenceRelevanceGate({
        titleOverlapScore: 0.24,
        topicOverlapScore: 0.33,
        keywordOverlapScore: 0.24,
        citationPercentileValue: 0.84,
        embeddingSimilarityScore: 0.69
      })
    ).toBe(false);
    expect(
      passesSharedReferenceRelevanceGate({
        titleOverlapScore: 0.25,
        topicOverlapScore: 0,
        keywordOverlapScore: 0,
        citationPercentileValue: null
      })
    ).toBe(true);
    expect(
      passesSharedReferenceRelevanceGate({
        titleOverlapScore: 0,
        topicOverlapScore: 0,
        keywordOverlapScore: 0,
        citationPercentileValue: null,
        embeddingSimilarityScore: 0.7
      })
    ).toBe(true);
  });

  it("does not treat one-off references as shared graph evidence", async () => {
    const works = Array.from({ length: 35 }, (_, index) =>
      work(`W-graph-${index}`, {
        display_name: `Machine learning HVAC CFD graph paper ${index}`,
        cited_by_count: 20 + index,
        publication_year: 2021 + (index % 5),
        referenced_works: [`https://openalex.org/W-unique-${index}`]
      })
    );

    const map = await buildResearchMap(request, works, unavailableCitationHistory, async () => [
      work("W-unique-reference", {
        display_name: "Generic unique reference",
        cited_by_count: 999,
        publication_year: 2018
      })
    ]);

    expect(map.citationNetworkSignals.sharedReferenceCount).toBe(0);
    expect(map.citationNetworkSignals.topSharedReferences).toHaveLength(0);
  });
});

describe("research direction summary", () => {
  const clusters: TopicCluster[] = [
    cluster("strong-soft-robotics", "Soft robotics", 10, 0.8, 0.78, 0.82),
    cluster("weak-service-robotics", "Service robotics", 9, 0.12, 0.18, 0.4),
    cluster("single-paper-noise", "Single paper topic", 1, 1, 0.95, 0.9)
  ];

  it("computes composite direction momentum score", () => {
    expect(calculateDirectionMomentumScore(clusters[0])).toBeCloseTo(0.828);
  });

  it("identifies stronger and weaker signals while excluding one-paper clusters", () => {
    const summary = buildResearchDirectionSummary(clusters);

    expect(summary.strongerRecentActivity.map((signal) => signal.label)).toContain("Soft robotics");
    expect(summary.weakerRecentPaperSignal.map((signal) => signal.label)).toContain("Service robotics");
    expect(summary.strongerRecentActivity.map((signal) => signal.label)).not.toContain("Single paper topic");
    expect(summary.weakerRecentPaperSignal.map((signal) => signal.label)).not.toContain("Single paper topic");
    expect(summary.strongerRecentActivity[0].supportingPaperIds.length).toBeGreaterThan(0);
  });

  it("never marks weaker recent-paper signals as strong", () => {
    expect(getLowerActivityConfidence(20)).toBe("moderate");
    expect(buildResearchDirectionSummary(clusters).weakerRecentPaperSignal.every((signal) => signal.confidence !== "strong")).toBe(true);
  });
});

describe("semantic preparation", () => {
  it("reconstructs OpenAlex inverted abstracts", () => {
    expect(reconstructAbstract({ CFD: [2], for: [1], Fast: [0], design: [3] })).toBe("Fast for CFD design");
  });

  it("builds compact paper text from title, abstract, topics, and keywords", () => {
    const text = buildCompactText(
      "Fast HVAC CFD",
      "A compact abstract.",
      { display_name: "HVAC airflow modeling" },
      [{ display_name: "Computational fluid dynamics" }],
      [{ display_name: "surrogate models" }]
    );

    expect(text).toContain("Title: Fast HVAC CFD");
    expect(text).toContain("Abstract: A compact abstract.");
    expect(text).toContain("HVAC airflow modeling");
    expect(text).toContain("surrogate models");
  });

  it("calculates cosine similarity and blends relevance", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(blendRelevance(0.5, 0.8, 0.4)).toBeCloseTo(0.585);
    expect(blendRelevance(0.5, null, 0.4)).toBe(0.5);
  });
});

function cluster(
  id: string,
  label: string,
  paperCount: number,
  recentPaperShare: number,
  averageRecentInfluenceScore: number,
  averageRelevanceScore: number
): TopicCluster {
  return {
    id,
    label,
    score: 0.5,
    paperCount,
    recentPaperShare,
    averageRecentInfluenceScore,
    averageRelevanceScore,
    paperIds: Array.from({ length: paperCount }, (_, index) => `${id}-paper-${index}`)
  };
}
