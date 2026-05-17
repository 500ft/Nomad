import { describe, expect, it } from "vitest";

import type { NormalizedWork, TopicCluster } from "../types";
import { computeTrendV2 } from "./trend-v2";

function nWork(overrides: Partial<NormalizedWork> & { id: string }): NormalizedWork {
  return {
    title: "Paper",
    doi: null,
    normalizedTitle: "paper",
    year: 2023,
    publicationDate: "2023-01-01",
    citationCount: 50,
    citationPercentile: 0.5,
    authors: [{ id: `A_${overrides.id}`, name: `Author ${overrides.id}` }],
    primaryTopic: { id: "T1", display_name: "Topic 1" },
    topics: [],
    keywords: [],
    type: "article",
    isRetracted: false,
    hasAbstract: true,
    url: `https://openalex.org/${overrides.id}`,
    relevanceScore: 0.7,
    logCitationScore: 0.5,
    citationPercentileScore: 0.5,
    citationsPerYearScore: 0.5,
    recencyScore: 0.5,
    sourceQualityScore: 0.5,
    foundationalScore: 0.5,
    recentInfluenceScore: 0.5,
    citationsPerYear: 10,
    ...overrides
  };
}

describe("computeTrendV2", () => {
  it("computes papers-per-year and a positive growth slope when papers ramp up", () => {
    const works: NormalizedWork[] = [
      ...Array.from({ length: 1 }, (_, i) => nWork({ id: `Y20-${i}`, year: 2020 })),
      ...Array.from({ length: 3 }, (_, i) => nWork({ id: `Y21-${i}`, year: 2021 })),
      ...Array.from({ length: 5 }, (_, i) => nWork({ id: `Y22-${i}`, year: 2022 })),
      ...Array.from({ length: 7 }, (_, i) => nWork({ id: `Y23-${i}`, year: 2023 })),
      ...Array.from({ length: 9 }, (_, i) => nWork({ id: `Y24-${i}`, year: 2024 }))
    ];
    const cluster: TopicCluster = {
      id: "T1",
      label: "Cluster",
      score: 0.7,
      paperCount: works.length,
      recentPaperShare: 1,
      averageRelevanceScore: 0.7,
      averageRecentInfluenceScore: 0.6,
      paperIds: works.slice(0, 8).map((w) => w.id)
    };
    const t = computeTrendV2(cluster, works);
    expect(t.papersByYear[2024]).toBe(9);
    expect(t.paperGrowthSlope).toBeGreaterThan(0);
    expect(t.dataConfidence).toBe("high");
  });

  it("counts recent reviews and active authors", () => {
    const works: NormalizedWork[] = [
      nWork({ id: "REV", year: 2024, type: "review" }),
      nWork({ id: "ART", year: 2024, type: "article" }),
      nWork({ id: "OLD", year: 2018, type: "review" })
    ];
    const cluster: TopicCluster = {
      id: "T1",
      label: "Cluster",
      score: 0.5,
      paperCount: works.length,
      recentPaperShare: 0.6,
      averageRelevanceScore: 0.7,
      averageRecentInfluenceScore: 0.5,
      paperIds: works.map((w) => w.id)
    };
    const t = computeTrendV2(cluster, works);
    expect(t.recentReviewCount).toBe(1);
    expect(t.newAuthorCount).toBe(2);
  });

  it("flags low confidence when sparse", () => {
    const works: NormalizedWork[] = [nWork({ id: "ONE", year: 2024 })];
    const cluster: TopicCluster = {
      id: "T1",
      label: "Cluster",
      score: 0.3,
      paperCount: 1,
      recentPaperShare: 1,
      averageRelevanceScore: 0.5,
      averageRecentInfluenceScore: 0.4,
      paperIds: ["ONE"]
    };
    const t = computeTrendV2(cluster, works);
    expect(t.dataConfidence).toBe("low");
  });
});
