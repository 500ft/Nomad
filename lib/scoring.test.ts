import { describe, expect, it } from "vitest";

import {
  buildCitationHistoryFromCountsByYear,
  buildCitationHistoryResult,
  buildOpenAlexCitationHistoryUrl,
  buildOpenAlexWorksByIdsUrl,
  buildOpenAlexWorksUrl,
  normalizeOpenAlexWorkId
} from "./openalex";
import { visibleCitationHistory } from "./citation-history-view";
import { blendRelevance, cosineSimilarity } from "./embeddings";
import {
  buildCompactText,
  buildProjectIdeas,
  buildQueryFocus,
  buildResearchDirectionSummary,
  buildResearchMap,
  calculateGraphSupportScore,
  calculateDirectionMomentumScore,
  computeProjectSpecificityScore,
  computeMapConfidence,
  getLowerActivityConfidence,
  hasMinimumProjectShape,
  isValidFirstExperiment,
  normalizeWorks,
  passesSharedReferenceRelevanceGate,
  reconstructAbstract,
  scoreWorks
} from "./scoring";
import type { CitationHistoryResult, CitationNetworkSignals, NormalizedWork, OpenAlexWork, QueryFocus, ResearchMapRequest, TopicCluster } from "./types";

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
    expect(map.queryFocus.reason.toLowerCase()).toContain("median relevance");
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
    expect(map.projectIdeas[0].title).not.toMatch(/Build a focused|research map/i);
    expect(map.projectIdeas[0].firstExperiment).toMatch(/\b(generate|compare|build|test|measure|simulate|train|benchmark|optimize|analyze)\b/i);
    expect(map.projectIdeas[0].title.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(map.projectIdeas[0].distinctivenessSignals?.join(" ").toLowerCase()).not.toMatch(/novel|original/);
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
    expect(map.projectIdeas.every((idea) => Boolean(idea.firstExperiment))).toBe(true);
  });
});

describe("project idea synthesis", () => {
  const focusedQuery: QueryFocus = {
    label: "focused",
    medianRelevance: 0.7,
    clusterCount: 1,
    weakClusterCount: 0,
    weakClusterShare: 0,
    topClusterShare: 0.6,
    usableWorks: 20,
    reason: "focused",
    suggestions: []
  };
  const citationSignals: CitationNetworkSignals = {
    seedPaperIds: [],
    seedPaperCount: 0,
    seedPapersWithReferences: 0,
    fetchedReferenceCount: 0,
    sharedReferenceCount: 0,
    graphCoverageRatio: 0,
    requestBudgetUsed: 0,
    requestBudgetMax: 7,
    topSharedReferences: [],
    limitations: []
  };

  it("rejects ingredient sets with only one project-shape dimension", () => {
    expect(hasMinimumProjectShape({ methods: ["surrogate modeling"], systems: [], applications: [], outcomes: [], materialsOrDatasets: [], limitationSignals: [] })).toBe(false);
    expect(hasMinimumProjectShape({ methods: [], systems: ["HVAC diffuser"], applications: [], outcomes: [], materialsOrDatasets: [], limitationSignals: [] })).toBe(false);
    expect(hasMinimumProjectShape({ methods: [], systems: [], applications: [], outcomes: ["pressure drop reduction"], materialsOrDatasets: [], limitationSignals: [] })).toBe(false);
    expect(hasMinimumProjectShape({ methods: ["surrogate modeling"], systems: ["HVAC diffuser"], applications: [], outcomes: [], materialsOrDatasets: [], limitationSignals: [] })).toBe(true);
  });

  it("rewards method + system + outcome above method + system only", () => {
    const partial = computeProjectSpecificityScore({ methods: ["surrogate modeling"], systems: ["HVAC diffuser"], applications: [], outcomes: [], materialsOrDatasets: [], limitationSignals: [] });
    const complete = computeProjectSpecificityScore({ methods: ["surrogate modeling"], systems: ["HVAC diffuser"], applications: [], outcomes: ["pressure drop reduction"], materialsOrDatasets: [], limitationSignals: [] });

    expect(complete).toBeGreaterThan(partial);
  });

  it("requires first experiments to be executable and connected to ingredients", () => {
    const ingredients = { methods: ["surrogate modeling"], systems: ["HVAC diffuser"], applications: [], outcomes: ["pressure drop reduction"], materialsOrDatasets: ["CFD cases"], limitationSignals: [] };

    expect(isValidFirstExperiment("Study HVAC airflow using machine learning.", ingredients)).toBe(false);
    expect(isValidFirstExperiment("Generate CFD cases for an HVAC diffuser, then train surrogate modeling to predict pressure drop reduction.", ingredients)).toBe(true);
  });

  it("caps one-paper project ideas below strong confidence", () => {
    const works = scoredWorks(1, 0.9).map((item) => ({
      ...item,
      id: "paper-1",
      title: "Surrogate modeling for HVAC diffuser pressure drop reduction",
      normalizedTitle: "surrogate modeling for hvac diffuser pressure drop reduction",
      compactText: "Surrogate modeling for HVAC diffuser pressure drop reduction using CFD cases",
      recentInfluenceScore: 0.95,
      graphSupportScore: 1
    }));
    const ideas = buildProjectIdeas(
      request,
      [{ ...cluster("c1", "HVAC diffuser modeling", 1, 1, 0.9, 0.9), paperIds: ["paper-1"] }],
      works,
      citationSignals,
      focusedQuery
    );

    expect(ideas[0].confidence).not.toBe("strong");
  });

  it("propagates broad and sparse query uncertainty to project confidence", () => {
    const works = scoredWorks(3, 0.9).map((item, index) => ({
      ...item,
      id: `paper-${index}`,
      title: `Surrogate modeling for HVAC diffuser pressure drop reduction ${index}`,
      normalizedTitle: `surrogate modeling for hvac diffuser pressure drop reduction ${index}`,
      compactText: "Surrogate modeling for HVAC diffuser pressure drop reduction using CFD cases",
      recentInfluenceScore: 0.95,
      graphSupportScore: 1
    }));
    const projectCluster = { ...cluster("c1", "HVAC diffuser modeling", 3, 1, 0.9, 0.9), paperIds: works.map((item) => item.id) };
    const broadIdeas = buildProjectIdeas(request, [projectCluster], works, citationSignals, { ...focusedQuery, label: "broad" });
    const sparseIdeas = buildProjectIdeas(request, [projectCluster], works, citationSignals, { ...focusedQuery, label: "sparse" });

    expect(broadIdeas[0].confidence).not.toBe("strong");
    expect(sparseIdeas[0].confidence).toBe("sparse");
  });

  it("collapses HVAC diffuser surrogate outcome swaps into one multi-objective concept", () => {
    const works = [
      "Surrogate modeling for HVAC diffuser efficiency improvement",
      "Surrogate modeling for HVAC diffuser prediction accuracy",
      "Surrogate modeling for HVAC diffuser thermal comfort"
    ].map((title, index) => ({
      ...scoredWorks(1, 0.72)[0],
      id: `diffuser-${index}`,
      title,
      normalizedTitle: title.toLowerCase(),
      compactText: `${title}. CFD diffuser angle inlet velocity room layout airflow distribution thermal comfort.`,
      recentInfluenceScore: 0.82,
      graphSupportScore: 0.4
    }));
    const ideas = buildProjectIdeas(
      request,
      works.map((item, index) => ({
        ...cluster(`diffuser-c${index}`, "HVAC diffuser surrogate modeling", 1, 1, 0.8, 0.72),
        paperIds: [item.id]
      })),
      works,
      citationSignals,
      focusedQuery
    );
    const hvacIdeas = ideas.filter((idea) => idea.projectIngredients?.systems.includes("HVAC diffuser"));

    expect(hvacIdeas).toHaveLength(1);
    expect(hvacIdeas[0].title).toBe("Multi-objective Surrogate Modeling For HVAC Diffuser Performance");
    expect(hvacIdeas[0].firstExperiment).toContain("Generate a small CFD dataset");
    expect(hvacIdeas[0].firstExperiment).not.toContain("CFD cases set");
    expect(hvacIdeas[0].firstExperiment).not.toContain("sensor logs");
    expect(ideas.map((idea) => idea.title).join(" ")).not.toMatch(/prediction accuracy|noise reduction/i);
  });

  it("does not create HVAC diffuser noise projects without acoustic evidence", () => {
    const works = scoredWorks(3, 0.75).map((item, index) => ({
      ...item,
      id: `airflow-${index}`,
      title: `Surrogate modeling for HVAC diffuser airflow ${index}`,
      normalizedTitle: `surrogate modeling for hvac diffuser airflow ${index}`,
      compactText: "Surrogate modeling for HVAC diffuser airflow distribution using CFD dataset and thermal comfort metrics.",
      recentInfluenceScore: 0.8,
      graphSupportScore: 0.4
    }));
    const projectCluster = { ...cluster("airflow", "HVAC diffuser airflow modeling", 3, 1, 0.8, 0.75), paperIds: works.map((item) => item.id) };
    const ideas = buildProjectIdeas(request, [projectCluster], works, citationSignals, focusedQuery);

    expect(ideas.map((idea) => idea.title).join(" ")).not.toMatch(/noise reduction/i);
  });
});

describe("query focus", () => {
  it("classifies sparse result sets before other focus signals", () => {
    const focus = buildQueryFocus(request, scoredWorks(12, 0.9), [
      cluster("dominant", "Dominant cluster", 12, 0.9, 0.9, 0.9)
    ]);

    expect(focus.label).toBe("sparse");
    expect(focus.reason).toContain("Only 12 usable works");
  });

  it("classifies focused result sets with relevance, concentration, and low weak-cluster share", () => {
    const focus = buildQueryFocus(request, scoredWorks(40, 0.7), [
      cluster("main", "Main cluster", 16, 0.8, 0.8, 0.75),
      cluster("side", "Side cluster", 10, 0.7, 0.7, 0.72)
    ]);

    expect(focus.label).toBe("focused");
    expect(focus.reason).toContain("0.70");
  });

  it("classifies broad result sets from low median relevance", () => {
    const focus = buildQueryFocus(request, scoredWorks(40, 0.38), [
      cluster("main", "Main cluster", 20, 0.8, 0.8, 0.5)
    ]);

    expect(focus.label).toBe("broad");
    expect(focus.reason).toContain("median relevance is 0.38");
  });

  it("classifies broad result sets from weak cluster share or many clusters", () => {
    const weakShareFocus = buildQueryFocus(request, scoredWorks(40, 0.52), [
      cluster("weak-1", "Weak one", 1, 0.2, 0.2, 0.3),
      cluster("weak-2", "Weak two", 1, 0.2, 0.2, 0.3),
      cluster("strong", "Strong", 20, 0.8, 0.8, 0.7)
    ]);
    const manyClusterFocus = buildQueryFocus(
      request,
      scoredWorks(40, 0.52),
      Array.from({ length: 12 }, (_, index) => cluster(`cluster-${index}`, `Cluster ${index}`, 3, 0.5, 0.5, 0.5))
    );

    expect(weakShareFocus.label).toBe("broad");
    expect(manyClusterFocus.label).toBe("broad");
  });

  it("returns deterministic suggestions without an LLM", () => {
    expect(buildQueryFocus({ ...request, topic: "robotics" }, scoredWorks(40, 0.52), []).suggestions).toEqual([
      "robotics force control for gripper design",
      "robotics actuator design for compliant manipulation",
      "soft robotics grippers for delicate object manipulation"
    ]);
    expect(buildQueryFocus({ ...request, topic: "battery thermal management" }, scoredWorks(40, 0.52), []).suggestions).toEqual([
      "temperature uniformity prediction for battery packs",
      "battery thermal management cooling plate optimization",
      "heat generation modeling for lithium ion battery cells"
    ]);
  });

  it("adds focus limitations to broad and sparse project ideas", async () => {
    const broadMap = await buildResearchMap(request, scoredFixtureWorks(35, 0.2), unavailableCitationHistory);
    const sparseMap = await buildResearchMap(request, scoredFixtureWorks(10, 0.9), unavailableCitationHistory);

    expect(broadMap.queryFocus.label).toBe("broad");
    expect(broadMap.projectIdeas[0].traceability.limitations).toContain("The source query was broad, so this idea should be treated as exploratory.");
    expect(sparseMap.queryFocus.label).toBe("sparse");
    expect(sparseMap.projectIdeas[0].traceability.limitations).toContain("Few usable works were found, so supporting evidence is limited.");
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

  it("hides zero-count years from the visible citation chart", async () => {
    const currentYear = new Date().getFullYear();
    const visible = visibleCitationHistory([
      { year: currentYear - 2, citationCount: 0, isPartialYear: false },
      { year: currentYear - 1, citationCount: 12, isPartialYear: false },
      { year: currentYear, citationCount: 0, isPartialYear: true }
    ]);

    expect(visible).toEqual([{ year: currentYear - 1, citationCount: 12, isPartialYear: false }]);
    expect(visible.some((item) => item.isPartialYear)).toBe(false);
  });

  it("returns no visible citation years when all chart counts are zero", async () => {
    expect(
      visibleCitationHistory([
        { year: 2024, citationCount: 0, isPartialYear: false },
        { year: 2025, citationCount: 0, isPartialYear: false }
      ])
    ).toHaveLength(0);
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

function scoredWorks(count: number, relevance: number): NormalizedWork[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `work-${index}`,
    doi: null,
    title: `Scored work ${index}`,
    normalizedTitle: `scored work ${index}`,
    year: 2024,
    publicationDate: "2024-01-01",
    citationCount: 10,
    citationPercentileValue: 0.5,
    authors: [],
    primaryTopic: null,
    topics: [],
    keywords: [],
    abstractText: null,
    compactText: `Scored work ${index}`,
    type: "article",
    isRetracted: false,
    hasAbstract: false,
    countsByYear: [],
    referencedWorks: [],
    referencedWorksCount: null,
    fwci: null,
    citedByApiUrl: null,
    url: `work-${index}`,
    relevanceScore: relevance,
    keywordRelevanceScore: relevance,
    semanticRelevanceScore: null,
    finalRelevanceScore: relevance,
    embeddingModel: null,
    logCitationScore: 0.5,
    citationPercentileScore: 0.5,
    citationsPerYearScore: 0.5,
    recencyScore: 0.5,
    sourceQualityScore: 1,
    graphSupportScore: 0,
    graphSupportSeedCount: 0,
    graphSupportSeedTotal: 0,
    foundationalScore: relevance,
    recentInfluenceScore: relevance,
    citationsPerYear: 5
  }));
}

function scoredFixtureWorks(count: number, relevance: number): OpenAlexWork[] {
  return Array.from({ length: count }, (_, index) =>
    work(`W-focus-${index}`, {
      display_name: `Focus test paper ${index}`,
      relevance_score: relevance * 100,
      publication_year: 2021 + (index % 5),
      cited_by_count: 10 + index,
      primary_topic: {
        id: index % 2 ? "https://openalex.org/T-focus-a" : "https://openalex.org/T-focus-b",
        display_name: index % 2 ? "Focused HVAC CFD" : "Focused surrogate modeling"
      }
    })
  );
}
