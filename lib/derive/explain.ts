import type { PaperRecommendation, ResearchMapResponse, TopicCluster } from "../types";

export type WhyReason = {
  kind: "score" | "citations" | "type" | "relevance" | "recency" | "cluster" | "author" | "warning";
  text: string;
};

const CURRENT_YEAR = new Date().getFullYear();

export function explainPaper(
  paper: PaperRecommendation,
  variant: "foundational" | "rising",
  map: ResearchMapResponse
): WhyReason[] {
  const reasons: WhyReason[] = [];
  const cluster = findCluster(paper.id, map.clusters);

  if (variant === "foundational") {
    reasons.push({ kind: "score", text: `High foundational score: ${(paper.score * 100).toFixed(0)} / 100` });
    if (paper.citationCount >= 200) {
      reasons.push({ kind: "citations", text: `Heavily cited: ${paper.citationCount} citations` });
    } else if (paper.citationCount >= 50) {
      reasons.push({ kind: "citations", text: `Well cited: ${paper.citationCount} citations` });
    }
  } else {
    reasons.push({
      kind: "score",
      text: `High recent-influence score: ${(paper.score * 100).toFixed(0)} / 100`
    });
    reasons.push({
      kind: "citations",
      text: `${paper.citationsPerYear.toFixed(0)} citations / year`
    });
    if (CURRENT_YEAR - paper.year <= 2) {
      reasons.push({ kind: "recency", text: `Recent publication (${paper.year})` });
    }
  }

  if (paper.type === "review") {
    reasons.push({ kind: "type", text: "Review article — good entry point" });
  } else if (paper.type === "preprint") {
    reasons.push({ kind: "type", text: "Preprint — not peer-reviewed yet" });
  }

  if (paper.relevanceScore >= 0.7) {
    reasons.push({ kind: "relevance", text: "Strong relevance to your query" });
  } else if (paper.relevanceScore < 0.4) {
    reasons.push({
      kind: "warning",
      text: `Low relevance score (${(paper.relevanceScore * 100).toFixed(0)}%) — may be off-topic for this query`
    });
  }

  if (cluster) {
    reasons.push({ kind: "cluster", text: `Cluster: ${cluster.label}` });
  }

  const authors = map.people.filter((person) => person.paperIds.includes(paper.id));
  if (authors.length) {
    const names = authors.slice(0, 2).map((a) => a.name).join(", ");
    const more = authors.length > 2 ? ` (+${authors.length - 2} more)` : "";
    reasons.push({
      kind: "author",
      text: `Linked to ${authors.length} active author${authors.length > 1 ? "s" : ""}: ${names}${more}`
    });
  }

  return reasons;
}

function findCluster(paperId: string, clusters: TopicCluster[]): TopicCluster | undefined {
  return clusters.find((c) => c.paperIds.includes(paperId));
}

/**
 * Real subfield: at least 3 papers AND meaningful share of corpus (or named cluster, not a singleton).
 */
export function isMeaningfulCluster(cluster: TopicCluster): boolean {
  return cluster.paperCount >= 3;
}

export function isLowRelevanceMap(map: ResearchMapResponse): boolean {
  return map.warnings.some((w) => /Low median relevance/i.test(w));
}
