import type { NormalizedWork, TopicCluster } from "../types";

export type TrendV2Signals = {
  clusterId: string;
  papersByYear: Record<number, number>;
  paperGrowthSlope: number;
  citationVelocity: number;
  recentReviewCount: number;
  newAuthorCount: number;
  dataConfidence: "high" | "medium" | "low";
};

export function computeTrendV2(
  cluster: TopicCluster,
  works: NormalizedWork[]
): TrendV2Signals {
  const members = works.filter(
    (w) => cluster.paperIds.includes(w.id) || isPrimaryMember(cluster, w)
  );
  const currentYear = new Date().getFullYear();
  const papersByYear: Record<number, number> = {};
  for (const w of members) {
    if (!w.year) continue;
    papersByYear[w.year] = (papersByYear[w.year] ?? 0) + 1;
  }

  const years = Object.keys(papersByYear).map(Number).sort((a, b) => a - b);
  const slope = years.length >= 2 ? linearRegressionSlope(years.map((y) => [y, papersByYear[y]])) : 0;

  const recentMembers = members.filter((w) => currentYear - w.year <= 3);
  const citationVelocity =
    recentMembers.length > 0
      ? avg(recentMembers.map((w) => w.citationsPerYear))
      : 0;

  const recentReviewCount = members.filter(
    (w) => w.type === "review" && currentYear - w.year <= 3
  ).length;

  const seenAuthors = new Set<string>();
  for (const w of members) {
    if (currentYear - w.year > 3) continue;
    for (const a of w.authors) seenAuthors.add(a.id);
  }
  const newAuthorCount = seenAuthors.size;

  let dataConfidence: TrendV2Signals["dataConfidence"];
  const abstractCoverage = members.length
    ? members.filter((w) => w.hasAbstract).length / members.length
    : 0;
  if (members.length >= 8 && abstractCoverage >= 0.5) {
    dataConfidence = "high";
  } else if (members.length >= 4) {
    dataConfidence = "medium";
  } else {
    dataConfidence = "low";
  }

  return {
    clusterId: cluster.id,
    papersByYear,
    paperGrowthSlope: slope,
    citationVelocity,
    recentReviewCount,
    newAuthorCount,
    dataConfidence
  };
}

function isPrimaryMember(cluster: TopicCluster, work: NormalizedWork): boolean {
  if (cluster.id.includes("#sub")) return false; // sub-clusters use explicit paperIds
  return work.primaryTopic?.id === cluster.id;
}

function linearRegressionSlope(points: Array<[number, number]>): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((s, [x]) => s + x, 0) / n;
  const meanY = points.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
