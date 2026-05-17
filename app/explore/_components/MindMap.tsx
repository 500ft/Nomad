"use client";

import { useState } from "react";

import { buildMindMap, type MindMapBranch, type MindMapCluster, type MindMapLeaf } from "@/lib/derive/mindmap";
import type { ResearchMapResponse } from "@/lib/types";
import styles from "../explore.module.css";
import { ConfidencePill } from "./ConfidencePill";
import { TrendStatusBadge } from "./TrendStatusBadge";

export function MindMap({ map }: { map: ResearchMapResponse }) {
  const tree = buildMindMap(map);

  return (
    <div className={styles.mindmap}>
      <div className={styles.mindmapTopic}>
        <span className={styles.mindmapTopicLabel}>Topic</span>
        <h3>{tree.topic}</h3>
      </div>
      <div className={styles.mindmapClusters}>
        {tree.clusters.map((cluster) => (
          <ClusterBlock key={cluster.trend.clusterId} cluster={cluster} />
        ))}
      </div>
      {tree.unaffiliated.length ? (
        <div className={styles.mindmapOrphans}>
          <h4>Other</h4>
          {tree.unaffiliated.map((branch) => (
            <BranchBlock key={branch.label} branch={branch} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ClusterBlock({ cluster }: { cluster: MindMapCluster }) {
  const [open, setOpen] = useState(true);
  return (
    <article className={styles.mindmapCluster}>
      <header className={styles.mindmapClusterHeader} onClick={() => setOpen(!open)}>
        <div>
          <h4>{cluster.trend.clusterLabel}</h4>
          <p className={styles.mindmapClusterMeta}>
            {cluster.trend.paperCount} papers | trend {(cluster.trend.trendScore * 100).toFixed(0)}
          </p>
        </div>
        <div className={styles.trendBadges}>
          <TrendStatusBadge status={cluster.trend.status} label={cluster.trend.statusLabel} />
          <ConfidencePill confidence={cluster.trend.confidence} compact />
          <button type="button" className={styles.toggleButton} aria-label="Toggle">
            {open ? "−" : "+"}
          </button>
        </div>
      </header>
      {open ? (
        <div className={styles.mindmapBranches}>
          {cluster.branches.map((branch) => (
            <BranchBlock key={branch.label} branch={branch} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function BranchBlock({ branch }: { branch: MindMapBranch }) {
  return (
    <div className={`${styles.mindmapBranch} ${styles[`branch-${branch.kind}`]}`}>
      <h5>{branch.label}</h5>
      <ul>
        {branch.leaves.map((leaf) => (
          <LeafItem key={leaf.id} leaf={leaf} />
        ))}
      </ul>
    </div>
  );
}

function LeafItem({ leaf }: { leaf: MindMapLeaf }) {
  return (
    <li className={styles.mindmapLeaf}>
      {leaf.url ? (
        <a href={leaf.url} target="_blank" rel="noreferrer">
          {leaf.label}
        </a>
      ) : (
        <span>{leaf.label}</span>
      )}
      {leaf.detail ? <p className={styles.mindmapLeafDetail}>{leaf.detail}</p> : null}
    </li>
  );
}
