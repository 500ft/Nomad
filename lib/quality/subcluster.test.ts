import { describe, expect, it } from "vitest";

import type { NormalizedWork, TopicCluster } from "../types";
import { splitMegaClusters } from "./subcluster";

function nWork(overrides: Partial<NormalizedWork> & { id: string; title: string }): NormalizedWork {
  return {
    doi: null,
    normalizedTitle: overrides.title.toLowerCase(),
    year: 2023,
    publicationDate: "2023-01-01",
    citationCount: 50,
    citationPercentileValue: 0.5,
    authors: [],
    primaryTopic: { id: "T_MEGA", display_name: "Battery thermal management" },
    topics: [],
    keywords: [],
    type: "article",
    isRetracted: false,
    hasAbstract: true,
    abstractText: "test abstract",
    compactText: "test abstract",
    countsByYear: [],
    referencedWorks: [],
    referencedWorksCount: null,
    fwci: null,
    citedByApiUrl: null,
    url: `https://openalex.org/${overrides.id}`,
    relevanceScore: 0.7,
    keywordRelevanceScore: 0.7,
    semanticRelevanceScore: null,
    finalRelevanceScore: 0.7,
    embeddingModel: null,
    logCitationScore: 0.5,
    citationPercentileScore: 0.5,
    citationsPerYearScore: 0.5,
    recencyScore: 0.5,
    sourceQualityScore: 0.5,
    foundationalScore: 0.5,
    recentInfluenceScore: 0.5,
    citationsPerYear: 10,
    ...overrides,
    graphSupportScore: overrides.graphSupportScore ?? 0,
    graphSupportSeedCount: overrides.graphSupportSeedCount ?? 0,
    graphSupportSeedTotal: overrides.graphSupportSeedTotal ?? 0
  };
}

describe("splitMegaClusters", () => {
  it("does not split clusters below the share threshold", () => {
    const works: NormalizedWork[] = Array.from({ length: 10 }, (_, i) =>
      nWork({ id: `W${i}`, title: `paper ${i} on heat transfer modeling` })
    );
    const clusters: TopicCluster[] = [
      {
        id: "T_MEGA",
        label: "Battery thermal management",
        score: 0.8,
        paperCount: 4,
        recentPaperShare: 1,
        averageRelevanceScore: 0.7,
        averageRecentInfluenceScore: 0.5,
        paperIds: ["W0", "W1", "W2", "W3"]
      }
    ];
    const out = splitMegaClusters(clusters, works);
    expect(out.splits.length).toBe(0);
    expect(out.clusters[0].id).toBe("T_MEGA");
  });

  it("splits a true mega-cluster into multiple subclusters by topic terms", () => {
    const cooling = ["liquid cooling", "channel cooling", "coolant flow rate"];
    const pcm = ["phase change material", "paraffin pcm latent heat", "nano-enhanced pcm storage"];
    const heatPipe = ["heat pipe loop", "vapor heat pipe condenser", "pulsating heat pipe"];
    const runaway = ["thermal runaway propagation", "abuse thermal runaway model", "overcharge thermal runaway"];

    const works: NormalizedWork[] = [];
    let i = 0;
    for (const corpus of [cooling, pcm, heatPipe, runaway]) {
      for (const seed of corpus) {
        for (let r = 0; r < 4; r++) {
          works.push(
            nWork({
              id: `W${i}`,
              title: `Investigation of ${seed} for battery thermal management variant ${r}`,
              keywords: seed.split(" ")
            })
          );
          i++;
        }
      }
    }
    // 48 papers, all under T_MEGA → 100% share
    const clusters: TopicCluster[] = [
      {
        id: "T_MEGA",
        label: "Battery thermal management",
        score: 0.85,
        paperCount: works.length,
        recentPaperShare: 1,
        averageRelevanceScore: 0.7,
        averageRecentInfluenceScore: 0.55,
        paperIds: works.slice(0, 8).map((w) => w.id)
      }
    ];
    const out = splitMegaClusters(clusters, works);
    expect(out.splits.length).toBe(1);
    expect(out.splits[0].children.length).toBeGreaterThanOrEqual(2);
    expect(out.clusters.length).toBeGreaterThanOrEqual(2);
    for (const child of out.clusters) {
      expect(child.paperCount).toBeGreaterThanOrEqual(3);
    }
    // Subcluster labels should reference parent and a distinctive term
    for (const child of out.clusters) {
      expect(child.label).toMatch(/Battery thermal management →/);
    }
  });

  it("does not split when the cluster is already small", () => {
    const works: NormalizedWork[] = Array.from({ length: 6 }, (_, i) =>
      nWork({ id: `W${i}`, title: `phase change material study ${i}` })
    );
    const clusters: TopicCluster[] = [
      {
        id: "T_MEGA",
        label: "BTMS",
        score: 0.8,
        paperCount: 6,
        recentPaperShare: 1,
        averageRelevanceScore: 0.7,
        averageRecentInfluenceScore: 0.5,
        paperIds: works.map((w) => w.id)
      }
    ];
    const out = splitMegaClusters(clusters, works);
    expect(out.splits.length).toBe(0);
  });
});
