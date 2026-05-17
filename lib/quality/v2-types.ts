import type { ResearchMapResponse, TopicCluster } from "../types";
import type { RelevanceReason } from "./relevance";
import type { TrendV2Signals } from "./trend-v2";

export type QualityReport = {
  papersFetched: number;
  papersKept: number;
  papersRejected: number;
  papersWarned: number;
  rejectionReasons: Record<RelevanceReason, number>;
  driftRejections: Array<{ title: string; domains: string[]; cosine: number }>;
  largestOriginalClusterShare: number;
  splitClusters: number;
  subclustersCreated: number;
  splits: Array<{ parentLabel: string; childLabels: string[] }>;
};

export type V2Cluster = TopicCluster & {
  parentClusterId?: string;
  parentClusterLabel?: string;
  trendV2?: TrendV2Signals;
};

export type V2ResearchMapResponse = Omit<ResearchMapResponse, "clusters" | "metricsVersion"> & {
  metricsVersion: "v2";
  engine: "v2";
  clusters: V2Cluster[];
  qualityReport: QualityReport;
};
