import { describe, expect, it } from "vitest";

import type { PaperRecommendation, ResearchMapResponse, TopicCluster } from "../types";
import { buildRoadmap } from "./roadmap";

function paper(id: string, overrides: Partial<PaperRecommendation> = {}): PaperRecommendation {
  return {
    id,
    title: `Paper ${id}`,
    year: 2023,
    url: `https://openalex.org/${id}`,
    doi: null,
    type: "article",
    citationCount: 100,
    citationsPerYear: 25,
    relevanceScore: 0.7,
    semanticRelevanceScore: null,
    score: 0.8,
    reasonCodes: [],
    authors: [],
    citationHistory: null,
    citationHistoryStatus: "unavailable",
    citationHistorySource: null,
    citationHistoryNote: "",
    graphSupportScore: 0,
    graphSupportNote: null,
    ...overrides
  };
}

function cluster(overrides: Partial<TopicCluster> = {}): TopicCluster {
  return {
    id: "C1",
    label: "Cluster 1",
    score: 0.7,
    paperCount: 10,
    recentPaperShare: 0.7,
    averageRelevanceScore: 0.7,
    averageRecentInfluenceScore: 0.6,
    paperIds: [],
    ...overrides
  };
}

function emptyMap(over: Partial<ResearchMapResponse> = {}): ResearchMapResponse {
  return {
    query: { topic: "x", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: 2026 },
    confidence: "moderate",
    foundationalPapers: [],
    recentInfluencePapers: [],
    people: [],
    clusters: [],
    queryFocus: {
      label: "moderate",
      medianRelevance: 0.7,
      clusterCount: 1,
      weakClusterCount: 0,
      weakClusterShare: 0,
      topClusterShare: 1,
      usableWorks: 30,
      reason: "test fixture",
      suggestions: []
    },
    citationSignals: {
      totalUsableWorks: 30,
      medianCitationsPerYear: 2,
      topClusterByPaperCount: null,
      topClusterByRecentInfluence: null,
      recentPaperShare: 0.5,
      confidence: "moderate"
    },
    citationNetworkSignals: {
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
    },
    researchDirectionSummary: {
      strongerRecentActivity: [],
      weakerRecentPaperSignal: [],
      briefSummary: "test fixture",
      limitations: []
    },
    semanticSignals: {
      enabled: false,
      model: null,
      embeddedPaperCount: 0,
      failedPaperCount: 0
    },
    projectIdeas: [],
    evidence: [],
    warnings: [],
    dataQuality: {
      usableWorks: 30,
      totalWorksFetched: 30,
      worksWithAbstract: 20,
      worksWithDoi: 20,
      deduplicatedWorks: 0,
      excludedRetractedWorks: 0
    },
    metricsVersion: "v1",
    generatedAt: new Date().toISOString(),
    ...over
  };
}

describe("buildRoadmap", () => {
  it("produces all 5 phases when input is rich", () => {
    const c1 = cluster({ id: "C1", paperIds: ["F1", "R1"], paperCount: 6 });
    const c2 = cluster({
      id: "C2",
      paperIds: ["F2", "R2", "R3", "R4"],
      paperCount: 12,
      recentPaperShare: 1.0,
      averageRecentInfluenceScore: 0.85,
      averageRelevanceScore: 0.9
    });
    const map = emptyMap({
      foundationalPapers: [
        paper("F1", { type: "review", score: 0.95 }),
        paper("F2", { score: 0.9 }),
        paper("F3", { score: 0.85 })
      ],
      recentInfluencePapers: [
        paper("R1", { type: "review", score: 0.85, year: 2024 }),
        paper("R2", { score: 0.8, year: 2024 }),
        paper("R3", { score: 0.78, year: 2024 }),
        paper("R4", { score: 0.75, year: 2024 })
      ],
      clusters: [c1, c2],
      projectIdeas: [
        { title: "P1", description: "d", difficulty: "beginner", requiredBackground: [], supportingPaperIds: [], supportingClusterIds: ["C1"], reasonCodes: [], whyNow: "now", mvpVersion: "v1", confidence: "moderate", traceability: { supportingPaperIds: [], supportingClusterIds: ["C1"], supportingReferenceIds: [], evidenceTypes: [], evidenceNote: "", limitations: [] } },
        { title: "P2", description: "d", difficulty: "beginner", requiredBackground: [], supportingPaperIds: [], supportingClusterIds: ["C2"], reasonCodes: [], whyNow: "now", mvpVersion: "v1", confidence: "moderate", traceability: { supportingPaperIds: [], supportingClusterIds: ["C2"], supportingReferenceIds: [], evidenceTypes: [], evidenceNote: "", limitations: [] } }
      ]
    });

    const r = buildRoadmap(map);
    const phaseIds = r.phases.map((p) => p.id);
    expect(phaseIds).toEqual(["start-here", "day-1", "days-2-3", "week-1", "week-2"]);
    expect(r.phases[0].papers.length).toBeGreaterThanOrEqual(2);
    expect(r.phases[4].projects?.length).toBe(2);
  });

  it("filters out papers below the relevance floor", () => {
    const map = emptyMap({
      foundationalPapers: [
        paper("HIGH", { score: 0.9, relevanceScore: 0.8 }),
        paper("LOW", { score: 0.95, relevanceScore: 0.2 })
      ],
      recentInfluencePapers: [],
      clusters: [],
      projectIdeas: []
    });
    const r = buildRoadmap(map);
    const allIds = r.phases.flatMap((p) => p.papers.map((rp) => rp.paper.id));
    expect(allIds).toContain("HIGH");
    expect(allIds).not.toContain("LOW");
    expect(r.warnings.some((w) => /Filtered/.test(w))).toBe(true);
  });

  it("hides singleton clusters and warns", () => {
    const map = emptyMap({
      clusters: [
        cluster({ id: "BIG", paperCount: 10, paperIds: ["F1"] }),
        cluster({ id: "ONE", paperCount: 1, paperIds: ["F2"] })
      ],
      foundationalPapers: [paper("F1"), paper("F2")],
      recentInfluencePapers: []
    });
    const r = buildRoadmap(map);
    expect(r.warnings.some((w) => /singleton/i.test(w))).toBe(true);
  });

  it("picks the highest-trend cluster for Week 1", () => {
    const c1 = cluster({ id: "C1", paperCount: 5, paperIds: ["R1", "R2"], recentPaperShare: 0.5, averageRecentInfluenceScore: 0.4 });
    const c2 = cluster({ id: "C2", paperCount: 8, paperIds: ["R3", "R4"], recentPaperShare: 1.0, averageRecentInfluenceScore: 0.8, averageRelevanceScore: 0.9 });
    const map = emptyMap({
      foundationalPapers: [],
      recentInfluencePapers: [paper("R1"), paper("R2"), paper("R3"), paper("R4")],
      clusters: [c1, c2],
      projectIdeas: []
    });
    const r = buildRoadmap(map);
    const week1 = r.phases.find((p) => p.id === "week-1");
    expect(week1).toBeDefined();
    expect(week1!.trend?.clusterId).toBe("C2");
  });
});
