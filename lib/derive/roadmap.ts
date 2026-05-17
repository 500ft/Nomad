import type { PaperRecommendation, ProjectIdea, ResearchMapResponse, TopicCluster } from "../types";
import { isMeaningfulCluster } from "./explain";
import { deriveClusterTrends, type ClusterTrend } from "./trend";

export type RoadmapPaper = {
  paper: PaperRecommendation;
  variant: "foundational" | "rising";
  cluster?: TopicCluster;
};

export type RoadmapPhase = {
  id: "start-here" | "day-1" | "days-2-3" | "week-1" | "week-2";
  title: string;
  subtitle: string;
  papers: RoadmapPaper[];
  projects?: ProjectIdea[];
  trend?: ClusterTrend;
};

export type Roadmap = {
  topic: string;
  phases: RoadmapPhase[];
  warnings: string[];
};

const RELEVANCE_FLOOR = 0.4;

export function buildRoadmap(map: ResearchMapResponse): Roadmap {
  const trends = deriveClusterTrends(map);
  const trendsById = new Map(trends.map((t) => [t.clusterId, t]));

  const usableFoundational = map.foundationalPapers.filter(
    (p) => p.relevanceScore >= RELEVANCE_FLOOR
  );
  const usableRising = map.recentInfluencePapers.filter(
    (p) => p.relevanceScore >= RELEVANCE_FLOOR
  );

  const reviews = usableFoundational.filter((p) => p.type === "review");
  const recentReviews = usableRising.filter((p) => p.type === "review");

  const startHere: RoadmapPaper[] = [];
  if (reviews.length) startHere.push(decorate(reviews[0], "foundational", map));
  const topFoundational = usableFoundational.find((p) => !startHere.some((rp) => rp.paper.id === p.id));
  if (topFoundational) startHere.push(decorate(topFoundational, "foundational", map));
  if (recentReviews.length) {
    const candidate = recentReviews.find((p) => !startHere.some((rp) => rp.paper.id === p.id));
    if (candidate) startHere.push(decorate(candidate, "rising", map));
  } else if (usableRising.length) {
    const candidate = usableRising.find((p) => !startHere.some((rp) => rp.paper.id === p.id));
    if (candidate) startHere.push(decorate(candidate, "rising", map));
  }

  const usedIds = new Set(startHere.map((rp) => rp.paper.id));

  const day1: RoadmapPaper[] = [];
  for (const p of [...reviews, ...usableFoundational]) {
    if (usedIds.has(p.id) || day1.some((rp) => rp.paper.id === p.id)) continue;
    day1.push(decorate(p, "foundational", map));
    usedIds.add(p.id);
    if (day1.length >= 3) break;
  }

  const meaningfulClusters = map.clusters.filter(isMeaningfulCluster);
  const days23: RoadmapPaper[] = [];
  for (const cluster of meaningfulClusters.slice(0, 5)) {
    const candidate = pickBestPaperForCluster(cluster, map, usedIds);
    if (candidate) {
      days23.push(decorate(candidate.paper, candidate.variant, map, cluster));
      usedIds.add(candidate.paper.id);
    }
  }

  const focusCluster = meaningfulClusters
    .map((c) => ({ cluster: c, trend: trendsById.get(c.id) }))
    .filter((entry): entry is { cluster: TopicCluster; trend: ClusterTrend } => Boolean(entry.trend))
    .sort((a, b) => b.trend.trendScore - a.trend.trendScore)[0];

  const week1: RoadmapPaper[] = [];
  if (focusCluster) {
    const focusPaperIds = new Set(focusCluster.cluster.paperIds);
    const risingInCluster = usableRising.filter((p) => focusPaperIds.has(p.id));
    for (const p of risingInCluster.slice(0, 5)) {
      if (usedIds.has(p.id)) continue;
      week1.push(decorate(p, "rising", map, focusCluster.cluster));
      usedIds.add(p.id);
    }
  }

  const week2Projects = map.projectIdeas.slice(0, 2);

  const phases: RoadmapPhase[] = [];
  if (startHere.length) {
    phases.push({
      id: "start-here",
      title: "Start Here",
      subtitle: "The single best review, the most central foundational paper, and the best recent overview.",
      papers: startHere
    });
  }
  if (day1.length) {
    phases.push({
      id: "day-1",
      title: "Day 1",
      subtitle: "Read 1 review and skim 2 foundational papers to get the shape of the field.",
      papers: day1
    });
  }
  if (days23.length) {
    phases.push({
      id: "days-2-3",
      title: "Days 2–3",
      subtitle: "Top paper from each major subfield. Skim the abstract and figures of each.",
      papers: days23
    });
  }
  if (week1.length && focusCluster) {
    phases.push({
      id: "week-1",
      title: "Week 1",
      subtitle: `Pick one cluster — going with “${focusCluster.cluster.label}” (highest trend score) — and read the 5 rising papers.`,
      papers: week1,
      trend: focusCluster.trend
    });
  }
  if (week2Projects.length) {
    phases.push({
      id: "week-2",
      title: "Week 2",
      subtitle: "Choose a project direction. Two evidence-backed starting ideas.",
      papers: [],
      projects: week2Projects
    });
  }

  const warnings: string[] = [];
  if (usableFoundational.length < map.foundationalPapers.length) {
    warnings.push(
      `Filtered ${map.foundationalPapers.length - usableFoundational.length} low-relevance foundational paper(s) below ${RELEVANCE_FLOOR * 100}% relevance.`
    );
  }
  if (!meaningfulClusters.length) {
    warnings.push("No subfield has 3+ papers — Days 2–3 picks may be missing.");
  } else if (meaningfulClusters.length < map.clusters.length) {
    warnings.push(
      `Hid ${map.clusters.length - meaningfulClusters.length} singleton cluster(s) (paperCount < 3). They are not real subfields.`
    );
  }

  return {
    topic: map.query.topic,
    phases,
    warnings
  };
}

function decorate(
  paper: PaperRecommendation,
  variant: "foundational" | "rising",
  map: ResearchMapResponse,
  cluster?: TopicCluster
): RoadmapPaper {
  return {
    paper,
    variant,
    cluster: cluster ?? map.clusters.find((c) => c.paperIds.includes(paper.id))
  };
}

function pickBestPaperForCluster(
  cluster: TopicCluster,
  map: ResearchMapResponse,
  usedIds: Set<string>
): { paper: PaperRecommendation; variant: "foundational" | "rising" } | null {
  const ids = new Set(cluster.paperIds);
  const candidates: { paper: PaperRecommendation; variant: "foundational" | "rising" }[] = [];
  for (const p of map.foundationalPapers) {
    if (!usedIds.has(p.id) && ids.has(p.id) && p.relevanceScore >= RELEVANCE_FLOOR) {
      candidates.push({ paper: p, variant: "foundational" });
    }
  }
  for (const p of map.recentInfluencePapers) {
    if (!usedIds.has(p.id) && ids.has(p.id) && p.relevanceScore >= RELEVANCE_FLOOR) {
      candidates.push({ paper: p, variant: "rising" });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.paper.score - a.paper.score);
  return candidates[0];
}
