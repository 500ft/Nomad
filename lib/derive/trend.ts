import type {
  PaperRecommendation,
  ResearchMapResponse,
  TopicCluster
} from "../types";

export type TrendStatus =
  | "rapidly-growing"
  | "growing"
  | "stable"
  | "cooling"
  | "low-signal";

export type TrendConfidence = "high" | "medium" | "low";

export type TrendContributor = {
  label: string;
  weight: number;
  value: number;
  contribution: number;
};

export type ClusterTrend = {
  clusterId: string;
  clusterLabel: string;
  paperCount: number;
  recentPaperShare: number;
  trendScore: number;
  status: TrendStatus;
  statusLabel: string;
  confidence: TrendConfidence;
  risingPaperContribution: number;
  contributors: TrendContributor[];
  whyLines: string[];
  warnings: string[];
};

const STATUS_LABELS: Record<TrendStatus, string> = {
  "rapidly-growing": "Rapidly Growing",
  growing: "Growing",
  stable: "Stable / Mature",
  cooling: "Cooling",
  "low-signal": "Low Signal"
};

const WEIGHTS = {
  recentPaperShare: 0.4,
  recentInfluence: 0.25,
  risingContribution: 0.2,
  relevance: 0.15
} as const;

export function deriveClusterTrends(
  map: ResearchMapResponse,
  opts: { includeSingletons?: boolean } = {}
): ClusterTrend[] {
  const totalRising = Math.max(1, map.recentInfluencePapers.length);
  const risingIdSet = new Set(map.recentInfluencePapers.map((p) => p.id));
  const clusters = opts.includeSingletons
    ? map.clusters
    : map.clusters.filter((c) => c.paperCount >= 3);

  return clusters.map((cluster) =>
    deriveClusterTrend(cluster, risingIdSet, totalRising, map.recentInfluencePapers)
  );
}

export function deriveClusterTrend(
  cluster: TopicCluster,
  risingIdSet: Set<string>,
  totalRising: number,
  risingPapers: PaperRecommendation[]
): ClusterTrend {
  const clusterRisingCount = cluster.paperIds.filter((id) => risingIdSet.has(id)).length;
  const risingPaperContribution = clamp01(clusterRisingCount / totalRising);

  const contributors: TrendContributor[] = [
    {
      label: "Recent paper share",
      weight: WEIGHTS.recentPaperShare,
      value: cluster.recentPaperShare,
      contribution: WEIGHTS.recentPaperShare * cluster.recentPaperShare
    },
    {
      label: "Avg recent-influence score",
      weight: WEIGHTS.recentInfluence,
      value: cluster.averageRecentInfluenceScore,
      contribution: WEIGHTS.recentInfluence * cluster.averageRecentInfluenceScore
    },
    {
      label: "Rising papers in this cluster",
      weight: WEIGHTS.risingContribution,
      value: risingPaperContribution,
      contribution: WEIGHTS.risingContribution * risingPaperContribution
    },
    {
      label: "Avg relevance to query",
      weight: WEIGHTS.relevance,
      value: cluster.averageRelevanceScore,
      contribution: WEIGHTS.relevance * cluster.averageRelevanceScore
    }
  ];

  const trendScore = contributors.reduce((sum, c) => sum + c.contribution, 0);
  const status = scoreToStatus(trendScore, cluster.paperCount);
  const confidence = computeConfidence(cluster.paperCount, clusterRisingCount);
  const whyLines = buildWhyLines(cluster, contributors, clusterRisingCount, risingPapers);
  const warnings = buildWarnings(cluster, confidence, status);

  return {
    clusterId: cluster.id,
    clusterLabel: cluster.label,
    paperCount: cluster.paperCount,
    recentPaperShare: cluster.recentPaperShare,
    trendScore,
    status,
    statusLabel: STATUS_LABELS[status],
    confidence,
    risingPaperContribution,
    contributors,
    whyLines,
    warnings
  };
}

function scoreToStatus(score: number, paperCount: number): TrendStatus {
  if (paperCount < 3) {
    return "low-signal";
  }
  if (score >= 0.65) return "rapidly-growing";
  if (score >= 0.5) return "growing";
  if (score >= 0.35) return "stable";
  if (score >= 0.2) return "cooling";
  return "low-signal";
}

function computeConfidence(paperCount: number, risingCount: number): TrendConfidence {
  if (paperCount >= 8 && risingCount >= 2) return "high";
  if (paperCount >= 4) return "medium";
  return "low";
}

function buildWhyLines(
  cluster: TopicCluster,
  contributors: TrendContributor[],
  clusterRisingCount: number,
  risingPapers: PaperRecommendation[]
): string[] {
  const lines: string[] = [];
  const top = contributors
    .slice()
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2);

  for (const c of top) {
    lines.push(
      `${c.label}: ${(c.value * 100).toFixed(0)}% (weight ${(c.weight * 100).toFixed(0)}%)`
    );
  }

  if (clusterRisingCount > 0) {
    const titles = risingPapers
      .filter((p) => cluster.paperIds.includes(p.id))
      .slice(0, 2)
      .map((p) => p.title);
    if (titles.length) {
      lines.push(`Recent-influence papers in cluster: ${titles.join("; ")}`);
    }
  }

  return lines;
}

function buildWarnings(
  cluster: TopicCluster,
  confidence: TrendConfidence,
  status: TrendStatus
): string[] {
  const warnings: string[] = [];
  if (confidence === "low") {
    warnings.push("Low confidence: too few papers in cluster to trust the trend label.");
  }
  if (status === "low-signal" && cluster.paperCount < 3) {
    warnings.push("Sparse cluster: trend signal is weak by sample size alone.");
  }
  if (cluster.recentPaperShare > 0.85 && cluster.paperCount < 5) {
    warnings.push("High recent share with few papers — could be a young topic or a noisy cluster.");
  }
  return warnings;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
