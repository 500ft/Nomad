"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ForceGraphMethods } from "react-force-graph-2d";

import type { ResearchMapResponse } from "@/lib/types";
import {
  buildResearchGraph,
  GRAPH_COLORS,
  GRAPH_TOPIC_ID,
  type GraphEdge,
  type GraphNode
} from "@/lib/derive/graph";
import styles from "../explore.module.css";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type LaidOutNode = GraphNode & { x?: number; y?: number; fx?: number; fy?: number };

const CANVAS_HEIGHT = 760;
const LABEL_ZOOM_THRESHOLD = 1.4;

const RADIUS_CLUSTERS = 360;
const RADIUS_PAPERS = 560;
const RADIUS_AUTHORS = 720;
const PAPER_ARC_PER_NODE_RAD = 0.16;
const PAPER_ARC_MAX_RAD = Math.PI / 2; // 90°

export function KnowledgeGraph({ map }: { map: ResearchMapResponse }) {
  const data = useMemo(() => buildResearchGraph(map), [map]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: CANVAS_HEIGHT });
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setSize({ width: Math.max(320, rect.width), height: CANVAS_HEIGHT });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(() => {
    const nodes: LaidOutNode[] = data.nodes.map((n) => ({ ...n }));
    const edges = data.edges.map((e) => ({ ...e }));
    layoutRadial(nodes, edges);
    return {
      nodes,
      links: edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
    };
  }, [data]);

  // Disable simulation forces — we're using fixed (fx, fy) positions, not physics.
  useEffect(() => {
    const t = setTimeout(() => {
      const fg = fgRef.current;
      if (!fg) return;
      fg.d3Force("charge", null);
      fg.d3Force("link", null);
      fg.d3Force("center", null);
      fg.d3Force("collide", null);
      fg.d3ReheatSimulation();
      setTimeout(() => fg.zoomToFit?.(500, 40), 100);
    }, 100);
    return () => clearTimeout(t);
  }, [graphData]);

  return (
    <div className={styles.graphWrap}>
      <div className={styles.legend}>
        <LegendDot color={GRAPH_COLORS.topic} label="Topic" />
        <LegendDot color={GRAPH_COLORS.cluster} label="Subfield cluster" />
        <LegendDot color={GRAPH_COLORS.foundational} label="Foundational paper" />
        <LegendDot color={GRAPH_COLORS.rising} label="Rising paper" />
        <LegendDot color={GRAPH_COLORS.author} label="Author" />
      </div>
      <div ref={containerRef} className={styles.graphCanvas}>
        <ForceGraph2D
          ref={fgRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          nodeRelSize={4}
          enableNodeDrag={true}
          linkColor={() => "rgba(120, 120, 140, 0.3)"}
          linkWidth={(l) => (l.kind === "topic-cluster" ? 1.6 : l.kind === "cluster-paper" ? 0.8 : 0.4)}
          onNodeHover={(node) => setHoverId(node ? (node as GraphNode).id : null)}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as LaidOutNode;
            if (typeof n.x !== "number" || typeof n.y !== "number") return;

            const isHover = hoverId === n.id;

            ctx.beginPath();
            ctx.arc(n.x, n.y, n.size, 0, 2 * Math.PI);
            ctx.fillStyle = n.color;
            ctx.fill();
            if (isHover) {
              ctx.lineWidth = 2 / globalScale;
              ctx.strokeStyle = "#0f172a";
              ctx.stroke();
            }

            const alwaysLabel = n.kind === "topic" || n.kind === "cluster";
            const showLabel = alwaysLabel || isHover || globalScale > LABEL_ZOOM_THRESHOLD;
            if (!showLabel) return;

            const fontSize =
              n.kind === "topic" ? Math.max(11, 14 / globalScale) :
              n.kind === "cluster" ? Math.max(9, 12 / globalScale) :
              Math.max(8, 10 / globalScale);
            const weight = alwaysLabel ? "600 " : "";
            ctx.font = `${weight}${fontSize}px system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";

            const max =
              n.kind === "topic" ? 36 :
              n.kind === "cluster" ? 30 :
              isHover ? 64 : 24;
            const text = truncate(displayLabel(n), max);

            if (isHover && !alwaysLabel) {
              const w = ctx.measureText(text).width;
              ctx.fillStyle = "rgba(255,255,255,0.94)";
              ctx.fillRect(n.x - w / 2 - 4, n.y + n.size + 1, w + 8, fontSize + 4);
            }
            ctx.fillStyle = "#0f172a";
            ctx.fillText(text, n.x, n.y + n.size + 2);
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as LaidOutNode;
            if (typeof n.x !== "number" || typeof n.y !== "number") return;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.size + 4, 0, 2 * Math.PI);
            ctx.fill();
          }}
          cooldownTicks={0}
        />
      </div>
      <p className={styles.smallNote}>
        Topic at the center, subfield clusters in the inner ring, papers fan out from each cluster, authors on the outside. Hover paper or author nodes for titles.
      </p>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className={styles.legendItem}>
      <span className={styles.legendDot} style={{ background: color }} />
      {label}
    </span>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** For subcluster labels like "Parent → Distinctive / Terms", show only the suffix. */
function displayLabel(n: GraphNode): string {
  if (n.kind !== "cluster") return n.label;
  const arrow = n.label.indexOf(" → ");
  return arrow >= 0 ? `→ ${n.label.slice(arrow + 3)}` : n.label;
}

/**
 * Deterministic radial mind-map layout.
 * - Topic at (0, 0).
 * - Clusters arranged on a ring, evenly spaced by angle.
 * - Each cluster's foundational/rising papers fan out in an arc beyond the cluster,
 *   centered on the cluster's outward direction.
 * - Each author placed beyond their first connected paper, or on an outer ring
 *   if they have no connected paper in the rendered set.
 *
 * Positions are written as fx/fy (fixed) so d3-force won't shuffle them.
 */
function layoutRadial(nodes: LaidOutNode[], edges: GraphEdge[]) {
  const byId = new Map<string, LaidOutNode>();
  for (const n of nodes) byId.set(n.id, n);

  const topic = byId.get(GRAPH_TOPIC_ID);
  if (topic) {
    topic.fx = 0;
    topic.fy = 0;
  }

  const clusters = nodes.filter((n) => n.kind === "cluster");
  const clusterCount = clusters.length || 1;
  const clusterAngles = new Map<string, number>();

  clusters.forEach((c, i) => {
    // Start at top (-π/2) and go clockwise.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / clusterCount;
    c.fx = RADIUS_CLUSTERS * Math.cos(angle);
    c.fy = RADIUS_CLUSTERS * Math.sin(angle);
    clusterAngles.set(c.id, angle);
  });

  // Map cluster -> [paper ids attached]
  const clusterPapers = new Map<string, string[]>();
  for (const c of clusters) clusterPapers.set(c.id, []);
  for (const e of edges) {
    if (e.kind !== "cluster-paper") continue;
    const list = clusterPapers.get(e.source);
    if (list && byId.has(e.target)) list.push(e.target);
  }

  for (const cluster of clusters) {
    const childIds = clusterPapers.get(cluster.id) ?? [];
    if (!childIds.length) continue;
    const baseAngle = clusterAngles.get(cluster.id)!;
    const arcSpread = Math.min(PAPER_ARC_MAX_RAD, childIds.length * PAPER_ARC_PER_NODE_RAD);
    const n = childIds.length;
    childIds.forEach((paperId, j) => {
      const child = byId.get(paperId);
      if (!child) return;
      const t = n === 1 ? 0 : j / (n - 1) - 0.5;
      const angle = baseAngle + t * arcSpread;
      child.fx = RADIUS_PAPERS * Math.cos(angle);
      child.fy = RADIUS_PAPERS * Math.sin(angle);
    });
  }

  // Authors: place beyond their first laid-out paper, or in an outer ring if orphaned.
  const authors = nodes.filter((n) => n.kind === "author");
  const orphanAuthors: LaidOutNode[] = [];
  for (const author of authors) {
    const paperEdge = edges.find(
      (e) => e.kind === "author-paper" && e.source === author.id && byId.has(e.target)
    );
    const paper = paperEdge ? byId.get(paperEdge.target) : undefined;
    if (paper && typeof paper.fx === "number" && typeof paper.fy === "number") {
      const dx = paper.fx;
      const dy = paper.fy;
      const dist = Math.hypot(dx, dy) || 1;
      const offset = 80;
      author.fx = paper.fx + (dx / dist) * offset;
      author.fy = paper.fy + (dy / dist) * offset;
    } else {
      orphanAuthors.push(author);
    }
  }
  orphanAuthors.forEach((author, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, orphanAuthors.length);
    author.fx = RADIUS_AUTHORS * Math.cos(angle);
    author.fy = RADIUS_AUTHORS * Math.sin(angle);
  });
}
