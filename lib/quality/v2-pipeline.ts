import { buildResearchMap, normalizeWorks, scoreWorks } from "../scoring";
import type { OpenAlexWork, ResearchMapRequest } from "../types";
import { filterByRelevance, type RelevanceReason, type RelevanceSummary } from "./relevance";
import { splitMegaClusters } from "./subcluster";
import { computeTrendV2 } from "./trend-v2";
import type { QualityReport, V2Cluster, V2ResearchMapResponse } from "./v2-types";

export async function buildV2ResearchMap(
  request: ResearchMapRequest,
  rawWorks: OpenAlexWork[]
): Promise<V2ResearchMapResponse> {
  const relevance = filterByRelevance(request.topic, rawWorks);
  const baseMap = await buildResearchMap(request, rawWorks, {});

  const normalization = normalizeWorks(request, rawWorks);
  const scored = scoreWorks(request, normalization.works);
  const split = splitMegaClusters(baseMap.clusters, scored);
  const v2Clusters: V2Cluster[] = split.clusters.slice(0, 12).map((cluster) => {
    const parentSplit = split.splits.find((item) => item.children.some((child) => child.id === cluster.id));
    return {
      ...cluster,
      parentClusterId: parentSplit?.parent.id,
      parentClusterLabel: parentSplit?.parent.label,
      trendV2: computeTrendV2(cluster, scored)
    };
  });

  return {
    ...baseMap,
    clusters: v2Clusters.slice(0, 8),
    warnings: [...buildV2Warnings(relevance, split), ...baseMap.warnings],
    metricsVersion: "v2",
    engine: "v2",
    qualityReport: buildQualityReport(rawWorks, relevance, split),
    generatedAt: new Date().toISOString()
  };
}

function buildV2Warnings(
  relevance: RelevanceSummary,
  split: ReturnType<typeof splitMegaClusters>
): string[] {
  const warnings: string[] = [];
  if (relevance.rejected.length) {
    warnings.push(`Filtered ${relevance.rejected.length} low-relevance paper(s) before ranking (v2 relevance gate).`);
  }
  if (relevance.warned.length) {
    warnings.push(`${relevance.warned.length} paper(s) kept with relevance warning (cosine 0.4-0.6).`);
  }
  if (split.splits.length) {
    const summary = split.splits.map((item) => `${item.parent.label} -> ${item.children.length} subclusters`).join("; ");
    warnings.push(`Split ${split.splits.length} mega-cluster(s): ${summary}`);
  }
  return warnings;
}

function buildQualityReport(
  rawWorks: OpenAlexWork[],
  relevance: RelevanceSummary,
  split: ReturnType<typeof splitMegaClusters>
): QualityReport {
  const driftRejections = relevance.rejected
    .filter((item) => item.driftDomains.length > 0)
    .map((item) => ({
      title: item.work.display_name ?? "(no title)",
      domains: item.driftDomains,
      cosine: Number(item.cosine.toFixed(3))
    }))
    .slice(0, 8);

  return {
    papersFetched: rawWorks.length,
    papersKept: relevance.kept.length,
    papersRejected: relevance.rejected.length,
    papersWarned: relevance.warned.length,
    rejectionReasons: normalizeRejectionReasons(relevance.rejectionReasons),
    driftRejections,
    largestOriginalClusterShare: Number(split.largestOriginalShare.toFixed(3)),
    splitClusters: split.splits.length,
    subclustersCreated: split.splits.reduce((sum, item) => sum + item.children.length, 0),
    splits: split.splits.map((item) => ({
      parentLabel: item.parent.label,
      childLabels: item.children.map((child) => child.label)
    }))
  };
}

function normalizeRejectionReasons(
  reasons: Partial<Record<RelevanceReason, number>>
): Record<RelevanceReason, number> {
  return {
    "low-cosine-similarity": reasons["low-cosine-similarity"] ?? 0,
    "drift-domain-conflict": reasons["drift-domain-conflict"] ?? 0,
    "no-content": reasons["no-content"] ?? 0
  };
}
