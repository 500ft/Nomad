import type { ResearchMapResponse } from "../types";

export type GraphNodeKind = "topic" | "cluster" | "foundational" | "rising" | "author";

export type GraphNode = {
  id: string;
  label: string;
  kind: GraphNodeKind;
  size: number;
  color: string;
  meta?: Record<string, unknown>;
};

export type GraphEdge = {
  source: string;
  target: string;
  kind: "topic-cluster" | "cluster-paper" | "author-paper";
};

export type ResearchGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const COLORS: Record<GraphNodeKind, string> = {
  topic: "#0f172a",
  cluster: "#6366f1",
  foundational: "#f59e0b",
  rising: "#10b981",
  author: "#ec4899"
};

const TOPIC_NODE_ID = "__topic__";

export function buildResearchGraph(map: ResearchMapResponse, opts: { topAuthors?: number } = {}): ResearchGraph {
  const topAuthors = opts.topAuthors ?? 8;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(node: GraphNode) {
    if (nodeIds.has(node.id)) return;
    nodes.push(node);
    nodeIds.add(node.id);
  }

  addNode({
    id: TOPIC_NODE_ID,
    label: map.query.topic,
    kind: "topic",
    size: 14,
    color: COLORS.topic
  });

  for (const cluster of map.clusters) {
    addNode({
      id: cluster.id,
      label: cluster.label,
      kind: "cluster",
      size: 6 + Math.min(8, cluster.score * 14),
      color: COLORS.cluster,
      meta: {
        paperCount: cluster.paperCount,
        recentPaperShare: cluster.recentPaperShare
      }
    });
    edges.push({ source: TOPIC_NODE_ID, target: cluster.id, kind: "topic-cluster" });
  }

  const paperToCluster = new Map<string, string>();
  for (const cluster of map.clusters) {
    for (const paperId of cluster.paperIds) {
      if (!paperToCluster.has(paperId)) {
        paperToCluster.set(paperId, cluster.id);
      }
    }
  }

  function attachPaper(paperId: string, label: string, kind: "foundational" | "rising", score: number) {
    addNode({
      id: paperId,
      label,
      kind,
      size: 4 + Math.min(6, score * 10),
      color: COLORS[kind]
    });
    const clusterId = paperToCluster.get(paperId);
    if (clusterId) {
      edges.push({ source: clusterId, target: paperId, kind: "cluster-paper" });
    } else {
      edges.push({ source: TOPIC_NODE_ID, target: paperId, kind: "cluster-paper" });
    }
  }

  for (const paper of map.foundationalPapers) {
    attachPaper(paper.id, paper.title, "foundational", paper.score);
  }
  for (const paper of map.recentInfluencePapers) {
    if (nodeIds.has(paper.id)) continue;
    attachPaper(paper.id, paper.title, "rising", paper.score);
  }

  for (const person of map.people.slice(0, topAuthors)) {
    addNode({
      id: person.id,
      label: person.name,
      kind: "author",
      size: 4 + Math.min(6, person.score * 8),
      color: COLORS.author,
      meta: {
        relevantPaperCount: person.relevantPaperCount,
        risingPaperInvolvementCount: person.risingPaperInvolvementCount
      }
    });
    for (const paperId of person.paperIds) {
      if (nodeIds.has(paperId)) {
        edges.push({ source: person.id, target: paperId, kind: "author-paper" });
      }
    }
  }

  return { nodes, edges };
}

export const GRAPH_TOPIC_ID = TOPIC_NODE_ID;
export const GRAPH_COLORS = COLORS;
