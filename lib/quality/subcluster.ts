import type { NormalizedWork, TopicCluster } from "../types";
import { tokenize } from "./text";

export type SplitClusterDecision = {
  parent: TopicCluster;
  children: TopicCluster[];
  splitReason: "mega-cluster" | "below-threshold";
};

export type SubclusterResult = {
  clusters: TopicCluster[];
  splits: SplitClusterDecision[];
  largestOriginalShare: number;
};

const MEGA_CLUSTER_SHARE = 0.5;
const MIN_SUBCLUSTER_SIZE = 3;
const MIN_PAPERS_TO_SPLIT = 12;
const TARGET_K_RANGE = [3, 4, 5, 6] as const;
const KMEANS_ITERATIONS = 25;

export function splitMegaClusters(
  clusters: TopicCluster[],
  works: NormalizedWork[]
): SubclusterResult {
  const total = works.length;
  const sortedClusters = clusters.slice().sort((a, b) => b.paperCount - a.paperCount);
  const largestShare = total ? (sortedClusters[0]?.paperCount ?? 0) / total : 0;

  const out: TopicCluster[] = [];
  const splits: SplitClusterDecision[] = [];

  for (const cluster of clusters) {
    const share = total ? cluster.paperCount / total : 0;
    if (share < MEGA_CLUSTER_SHARE || cluster.paperCount < MIN_PAPERS_TO_SPLIT) {
      out.push(cluster);
      continue;
    }
    const children = subclusterByTfidf(cluster, works);
    if (children.length >= 2) {
      splits.push({ parent: cluster, children, splitReason: "mega-cluster" });
      out.push(...children);
    } else {
      out.push(cluster);
    }
  }

  return {
    clusters: out.sort((a, b) => b.score - a.score),
    splits,
    largestOriginalShare: largestShare
  };
}

function subclusterByTfidf(parent: TopicCluster, allWorks: NormalizedWork[]): TopicCluster[] {
  // Cluster from full membership, not just the top-8 parent.paperIds: any normalized
  // work whose primary topic id matches the parent.
  const members = allWorks.filter((w) => bestTopicId(w) === parent.id);
  if (members.length < MIN_PAPERS_TO_SPLIT) return [parent];

  const docTokens = members.map((w) => tokenize(buildText(w)));
  const N = members.length;
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  // Drop tokens that appear in more than 80% of docs (cluster-wide noise) or fewer than 2 docs.
  const idf = new Map<string, number>();
  for (const [t, c] of df) {
    if (c < 2) continue;
    if (c / N > 0.8) continue;
    idf.set(t, Math.log(1 + N / c));
  }

  const vectors = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, count] of tf) {
      const w = (idf.get(t) ?? 0) * (1 + Math.log(count));
      if (w > 0) v.set(t, w);
    }
    return v;
  });

  const bestK = pickBestK(vectors);
  const assignments = kmeans(vectors, bestK);

  const buckets = new Map<number, NormalizedWork[]>();
  members.forEach((work, i) => {
    const c = assignments[i];
    const arr = buckets.get(c) ?? [];
    arr.push(work);
    buckets.set(c, arr);
  });

  // Pre-compute parent-wide token counts so labels can be DISTINCTIVE,
  // not just frequent (otherwise every sub-bucket inherits the parent label).
  const parentCounts = countTokens(members);
  const usedLabels = new Set<string>();

  const children: TopicCluster[] = [];
  let childIndex = 0;
  for (const [, bucketMembers] of buckets) {
    if (bucketMembers.length < MIN_SUBCLUSTER_SIZE) continue;
    const label = labelBucket(bucketMembers, parent.label, members.length, parentCounts, usedLabels);
    children.push(buildChildCluster(parent, bucketMembers, label, ++childIndex));
  }

  if (children.length < 2) return [parent];
  return children;
}

function countTokens(works: NormalizedWork[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const work of works) {
    const tokens = new Set(tokenize(buildText(work)));
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

function bestTopicId(work: NormalizedWork): string {
  if (work.primaryTopic?.id) return work.primaryTopic.id;
  if (work.topics[0]?.id) return work.topics[0].id;
  return `keyword:${(work.keywords[0] ?? "").toLowerCase()}`;
}

function buildText(w: NormalizedWork): string {
  return [
    w.title,
    w.primaryTopic?.display_name ?? "",
    ...w.topics.map((t) => t.display_name ?? ""),
    ...w.keywords
  ].join(" ");
}

function pickBestK(vectors: Map<string, number>[]): number {
  // Simple heuristic: try a few k, pick the one with the lowest average within-cluster
  // dispersion that still produces at least MIN_SUBCLUSTER_SIZE per cluster.
  let bestK: number = TARGET_K_RANGE[0];
  let bestScore = Infinity;
  for (const k of TARGET_K_RANGE) {
    if (k > vectors.length) continue;
    const assignments = kmeans(vectors, k);
    const counts = new Map<number, number>();
    for (const a of assignments) counts.set(a, (counts.get(a) ?? 0) + 1);
    if (Math.min(...counts.values()) < MIN_SUBCLUSTER_SIZE) continue;
    const dispersion = withinClusterDispersion(vectors, assignments, k);
    // Prefer larger k if dispersion is comparable; subtract 0.01*k as a tie-breaker.
    const adjusted = dispersion - 0.01 * k;
    if (adjusted < bestScore) {
      bestScore = adjusted;
      bestK = k;
    }
  }
  return bestK;
}

function kmeans(vectors: Map<string, number>[], k: number): number[] {
  if (k <= 1 || k >= vectors.length) {
    return vectors.map(() => 0);
  }
  const seeds = pickSeeds(vectors, k);
  const centroids = seeds.map(cloneVec);
  const assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      const a = nearestCentroid(vectors[i], centroids);
      if (a !== assignments[i]) {
        assignments[i] = a;
        changed = true;
      }
    }
    if (!changed) break;
    // Recompute centroids
    const sums: Map<string, number>[] = Array.from({ length: k }, () => new Map());
    const counts = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const a = assignments[i];
      const target = sums[a];
      counts[a]++;
      for (const [t, w] of vectors[i]) {
        target.set(t, (target.get(t) ?? 0) + w);
      }
    }
    for (let c = 0; c < k; c++) {
      const cnt = counts[c] || 1;
      const next = new Map<string, number>();
      for (const [t, w] of sums[c]) next.set(t, w / cnt);
      centroids[c] = next;
    }
  }
  return assignments;
}

function pickSeeds(vectors: Map<string, number>[], k: number): Map<string, number>[] {
  // k-means++ seeding (deterministic): first vector with most tokens, then maximize distance.
  const seeds: Map<string, number>[] = [];
  const used = new Set<number>();
  let firstIdx = 0;
  let maxSize = -1;
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].size > maxSize) {
      maxSize = vectors[i].size;
      firstIdx = i;
    }
  }
  used.add(firstIdx);
  seeds.push(vectors[firstIdx]);
  while (seeds.length < k) {
    let bestIdx = -1;
    let bestMinDist = -Infinity;
    for (let i = 0; i < vectors.length; i++) {
      if (used.has(i)) continue;
      let minDist = Infinity;
      for (const seed of seeds) {
        const d = 1 - cosineSim(vectors[i], seed);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    used.add(bestIdx);
    seeds.push(vectors[bestIdx]);
  }
  return seeds;
}

function nearestCentroid(v: Map<string, number>, centroids: Map<string, number>[]): number {
  let bestIdx = 0;
  let bestSim = -Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const s = cosineSim(v, centroids[c]);
    if (s > bestSim) {
      bestSim = s;
      bestIdx = c;
    }
  }
  return bestIdx;
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [, w] of b) nb += w * w;
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  for (const [t, w] of small) {
    const wb = big.get(t);
    if (wb) dot += w * wb;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function cloneVec(v: Map<string, number>): Map<string, number> {
  return new Map(v);
}

function withinClusterDispersion(
  vectors: Map<string, number>[],
  assignments: number[],
  k: number
): number {
  const centroids: Map<string, number>[] = Array.from({ length: k }, () => new Map());
  const counts = new Array(k).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    const a = assignments[i];
    counts[a]++;
    for (const [t, w] of vectors[i]) {
      centroids[a].set(t, (centroids[a].get(t) ?? 0) + w);
    }
  }
  for (let c = 0; c < k; c++) {
    const cnt = counts[c] || 1;
    for (const [t, w] of centroids[c]) centroids[c].set(t, w / cnt);
  }
  let sum = 0;
  for (let i = 0; i < vectors.length; i++) {
    sum += 1 - cosineSim(vectors[i], centroids[assignments[i]]);
  }
  return sum / Math.max(1, vectors.length);
}

function labelBucket(
  members: NormalizedWork[],
  parentLabel: string,
  parentSize: number,
  parentCounts: Map<string, number>,
  usedLabels: Set<string>
): string {
  // Distinctiveness ≠ frequency. A token that appears in 100% of the bucket but
  // 100% of the parent is the parent label, not a sub-label. We rank by:
  //   distinctiveness = bucket_prevalence * log(1 + bucket_prev / parent_prev)
  // and additionally exclude tokens that appear in the parent label itself.
  const bucketCounts = countTokens(members);
  const N_bucket = members.length;
  const parentLabelTokens = new Set(tokenize(parentLabel));

  const sorted = Array.from(bucketCounts.entries())
    .filter(([t, c]) => t.length > 3 && c >= 2 && !parentLabelTokens.has(t))
    .map(([t, c]) => {
      const bucketPrev = c / Math.max(1, N_bucket);
      const parentPrev = (parentCounts.get(t) ?? 0) / Math.max(1, parentSize);
      const ratio = bucketPrev / Math.max(0.01, parentPrev);
      const distinctiveness = bucketPrev * Math.log(1 + ratio);
      return { t, distinctiveness, bucketPrev };
    })
    .filter((x) => x.bucketPrev >= 0.25) // appear in at least a quarter of bucket
    .sort((a, b) => b.distinctiveness - a.distinctiveness);

  const picked: string[] = [];
  for (const { t } of sorted) {
    if (picked.length >= 3) break;
    if (picked.includes(t)) continue;
    picked.push(t);
  }

  if (!picked.length) {
    return `${parentLabel} subgroup ${usedLabels.size + 1}`;
  }

  // Avoid duplicate labels across siblings — if the top distinctive terms collide,
  // bring in the next-best term.
  let label = formatLabel(parentLabel, picked);
  if (usedLabels.has(label)) {
    for (const { t } of sorted.slice(picked.length)) {
      const next = [...picked.slice(0, 2), t];
      const candidate = formatLabel(parentLabel, next);
      if (!usedLabels.has(candidate)) {
        label = candidate;
        break;
      }
    }
    if (usedLabels.has(label)) {
      label = `${label} (${usedLabels.size + 1})`;
    }
  }
  usedLabels.add(label);
  return label;
}

function formatLabel(parentLabel: string, tokens: string[]): string {
  const titled = tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" / ");
  return `${parentLabel} → ${titled}`;
}

function buildChildCluster(
  parent: TopicCluster,
  members: NormalizedWork[],
  label: string,
  index: number
): TopicCluster {
  const currentYear = new Date().getFullYear();
  const recentWorks = members.filter((w) => currentYear - w.year <= 5);
  const recentPaperShare = recentWorks.length / Math.max(1, members.length);
  const averageRelevanceScore = avg(members.map((w) => w.relevanceScore));
  const averageRecentInfluenceScore = avg(members.map((w) => w.recentInfluenceScore));
  // Re-derive cluster score with the same weighting as v1's buildClusters but normalized
  // against this child's local size only — we don't have access to a "max paper count"
  // across all children + uninstantiated ones, so use parent's normalized share as a proxy.
  const normalizedPaperCount = members.length / Math.max(1, parent.paperCount);
  const score =
    0.35 * normalizedPaperCount +
    0.25 * averageRecentInfluenceScore +
    0.2 * recentPaperShare +
    0.2 * averageRelevanceScore;

  const paperIds = members
    .slice()
    .sort((a, b) => b.recentInfluenceScore - a.recentInfluenceScore)
    .slice(0, 8)
    .map((w) => w.id);

  return {
    id: `${parent.id}#sub${index}`,
    label,
    score,
    paperCount: members.length,
    recentPaperShare,
    averageRelevanceScore,
    averageRecentInfluenceScore,
    paperIds
  };
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
