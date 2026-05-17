import type { PaperRecommendation, ProjectIdea, ResearcherRecommendation, ResearchMapResponse } from "../types";
import { deriveClusterTrends, type ClusterTrend } from "./trend";

export type MindMapLeafKind = "foundational" | "rising" | "author" | "project";

export type MindMapLeaf = {
  id: string;
  kind: MindMapLeafKind;
  label: string;
  detail?: string;
  url?: string;
};

export type MindMapBranch = {
  label: string;
  kind: MindMapLeafKind;
  leaves: MindMapLeaf[];
};

export type MindMapCluster = {
  trend: ClusterTrend;
  branches: MindMapBranch[];
};

export type MindMapTree = {
  topic: string;
  clusters: MindMapCluster[];
  unaffiliated: MindMapBranch[];
};

const PER_BRANCH_LIMIT = 4;

export function buildMindMap(map: ResearchMapResponse): MindMapTree {
  const trends = deriveClusterTrends(map);
  const foundationalById = mapById(map.foundationalPapers);
  const risingById = mapById(map.recentInfluencePapers);
  const authorsById = mapPeopleById(map.people);

  const usedFoundational = new Set<string>();
  const usedRising = new Set<string>();

  const clusters: MindMapCluster[] = trends.map((trend) => {
    const cluster = map.clusters.find((c) => c.id === trend.clusterId)!;
    const ids = new Set(cluster.paperIds);

    const foundationalLeaves = pickPapers(foundationalById, ids, "foundational", usedFoundational);
    const risingLeaves = pickPapers(risingById, ids, "rising", usedRising);
    const authorLeaves = pickAuthors(authorsById, ids);
    const projectLeaves = pickProjects(map.projectIdeas, cluster.id);

    const branches: MindMapBranch[] = [];
    if (foundationalLeaves.length) {
      branches.push({ label: "Foundational", kind: "foundational", leaves: foundationalLeaves });
    }
    if (risingLeaves.length) {
      branches.push({ label: "Rising", kind: "rising", leaves: risingLeaves });
    }
    if (authorLeaves.length) {
      branches.push({ label: "Active authors", kind: "author", leaves: authorLeaves });
    }
    if (projectLeaves.length) {
      branches.push({ label: "Project ideas", kind: "project", leaves: projectLeaves });
    }

    return { trend, branches };
  });

  const unaffiliated: MindMapBranch[] = [];
  const orphanFoundational = map.foundationalPapers
    .filter((p) => !usedFoundational.has(p.id))
    .slice(0, PER_BRANCH_LIMIT)
    .map(toPaperLeaf("foundational"));
  if (orphanFoundational.length) {
    unaffiliated.push({ label: "Other foundational", kind: "foundational", leaves: orphanFoundational });
  }
  const orphanRising = map.recentInfluencePapers
    .filter((p) => !usedRising.has(p.id))
    .slice(0, PER_BRANCH_LIMIT)
    .map(toPaperLeaf("rising"));
  if (orphanRising.length) {
    unaffiliated.push({ label: "Other rising", kind: "rising", leaves: orphanRising });
  }

  return {
    topic: map.query.topic,
    clusters,
    unaffiliated
  };
}

function mapById<T extends { id: string }>(items: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const item of items) m.set(item.id, item);
  return m;
}

function mapPeopleById(people: ResearcherRecommendation[]): Map<string, ResearcherRecommendation> {
  return mapById(people);
}

function pickPapers(
  byId: Map<string, PaperRecommendation>,
  clusterPaperIds: Set<string>,
  kind: "foundational" | "rising",
  usedSink: Set<string>
): MindMapLeaf[] {
  const leaves: MindMapLeaf[] = [];
  for (const paperId of clusterPaperIds) {
    const paper = byId.get(paperId);
    if (!paper) continue;
    leaves.push(toPaperLeaf(kind)(paper));
    usedSink.add(paper.id);
    if (leaves.length >= PER_BRANCH_LIMIT) break;
  }
  return leaves;
}

function pickAuthors(
  authorsById: Map<string, ResearcherRecommendation>,
  clusterPaperIds: Set<string>
): MindMapLeaf[] {
  const out: MindMapLeaf[] = [];
  for (const author of authorsById.values()) {
    const overlap = author.paperIds.filter((id) => clusterPaperIds.has(id)).length;
    if (overlap === 0) continue;
    out.push({
      id: author.id,
      kind: "author",
      label: author.name,
      detail: `${overlap} paper${overlap === 1 ? "" : "s"} in cluster | ${author.relevantPaperCount} total relevant`,
      url: author.id
    });
    if (out.length >= PER_BRANCH_LIMIT) break;
  }
  return out;
}

function pickProjects(projects: ProjectIdea[], clusterId: string): MindMapLeaf[] {
  return projects
    .filter((p) => p.supportingClusterIds.includes(clusterId))
    .slice(0, PER_BRANCH_LIMIT)
    .map((p) => ({
      id: p.title,
      kind: "project" as const,
      label: p.title,
      detail: p.whyNow
    }));
}

function toPaperLeaf(kind: "foundational" | "rising") {
  return (paper: PaperRecommendation): MindMapLeaf => ({
    id: paper.id,
    kind,
    label: paper.title,
    detail: `${paper.year} | ${paper.citationCount} cites | score ${paper.score.toFixed(2)}`,
    url: paper.url
  });
}
