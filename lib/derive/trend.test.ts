import { describe, expect, it } from "vitest";

import type { ResearchMapResponse, TopicCluster, PaperRecommendation } from "../types";
import { deriveClusterTrend, deriveClusterTrends } from "./trend";

function paper(id: string, overrides: Partial<PaperRecommendation> = {}): PaperRecommendation {
  return {
    id,
    title: `Paper ${id}`,
    year: 2024,
    url: `https://openalex.org/${id}`,
    doi: null,
    type: "article",
    citationCount: 10,
    citationsPerYear: 5,
    relevanceScore: 0.7,
    score: 0.5,
    reasonCodes: [],
    authors: [],
    ...overrides
  };
}

function cluster(overrides: Partial<TopicCluster> = {}): TopicCluster {
  return {
    id: "T1",
    label: "Cluster 1",
    score: 0.6,
    paperCount: 10,
    recentPaperShare: 0.7,
    averageRelevanceScore: 0.6,
    averageRecentInfluenceScore: 0.5,
    paperIds: ["P1", "P2", "P3"],
    ...overrides
  };
}

describe("deriveClusterTrend", () => {
  it("produces a trend score in [0,1] from contributors", () => {
    const t = deriveClusterTrend(cluster(), new Set(["P1"]), 10, [paper("P1")]);
    expect(t.trendScore).toBeGreaterThanOrEqual(0);
    expect(t.trendScore).toBeLessThanOrEqual(1);
    expect(t.contributors).toHaveLength(4);
    expect(t.contributors.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 5);
  });

  it("labels high-signal clusters as rapidly-growing", () => {
    const c = cluster({
      paperCount: 20,
      recentPaperShare: 1,
      averageRecentInfluenceScore: 1,
      averageRelevanceScore: 1,
      paperIds: ["R1", "R2", "R3", "R4"]
    });
    const rising = ["R1", "R2", "R3", "R4"].map((id) => paper(id));
    const t = deriveClusterTrend(c, new Set(rising.map((p) => p.id)), 4, rising);
    expect(t.status).toBe("rapidly-growing");
    expect(t.statusLabel).toBe("Rapidly Growing");
  });

  it("labels sparse clusters as low-signal regardless of score", () => {
    const c = cluster({
      paperCount: 2,
      recentPaperShare: 1,
      averageRecentInfluenceScore: 1,
      averageRelevanceScore: 1
    });
    const t = deriveClusterTrend(c, new Set(), 5, []);
    expect(t.status).toBe("low-signal");
  });

  it("computes high confidence with enough papers and rising contribution", () => {
    const c = cluster({ paperCount: 10, paperIds: ["R1", "R2"] });
    const rising = [paper("R1"), paper("R2")];
    const t = deriveClusterTrend(c, new Set(["R1", "R2"]), 5, rising);
    expect(t.confidence).toBe("high");
  });

  it("falls back to low confidence with few papers", () => {
    const c = cluster({ paperCount: 2 });
    const t = deriveClusterTrend(c, new Set(), 5, []);
    expect(t.confidence).toBe("low");
    expect(t.warnings.some((w) => /Low confidence/.test(w))).toBe(true);
  });

  it("includes top contributors in whyLines", () => {
    const t = deriveClusterTrend(cluster(), new Set(["P1"]), 10, [paper("P1")]);
    expect(t.whyLines.length).toBeGreaterThan(0);
    expect(t.whyLines[0]).toMatch(/%/);
  });
});

describe("deriveClusterTrends", () => {
  it("returns one trend per cluster in input order", () => {
    const map: ResearchMapResponse = {
      query: { topic: "x", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: 2026 },
      confidence: "moderate",
      foundationalPapers: [],
      recentInfluencePapers: [paper("R1")],
      people: [],
      clusters: [cluster({ id: "A", label: "A", paperIds: ["R1"] }), cluster({ id: "B", label: "B" })],
      projectIdeas: [],
      evidence: [],
      warnings: [],
      dataQuality: {
        usableWorks: 10,
        totalWorksFetched: 10,
        worksWithAbstract: 5,
        worksWithDoi: 5,
        deduplicatedWorks: 0,
        excludedRetractedWorks: 0
      },
      metricsVersion: "v1",
      generatedAt: new Date().toISOString()
    };

    const out = deriveClusterTrends(map);
    expect(out).toHaveLength(2);
    expect(out[0].clusterId).toBe("A");
    expect(out[1].clusterId).toBe("B");
    expect(out[0].risingPaperContribution).toBeGreaterThan(0);
    expect(out[1].risingPaperContribution).toBe(0);
  });
});
