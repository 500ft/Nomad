"use client";

import { useState } from "react";

import { explainPaper } from "@/lib/derive/explain";
import type { PaperRecommendation, ResearchMapResponse, TopicCluster } from "@/lib/types";
import styles from "../explore.module.css";

export function PaperCard({
  paper,
  variant,
  cluster,
  map,
  badge
}: {
  paper: PaperRecommendation;
  variant: "foundational" | "rising";
  cluster?: TopicCluster;
  map: ResearchMapResponse;
  badge?: string;
}) {
  const [open, setOpen] = useState(false);
  const reasons = explainPaper(paper, variant, map);
  const variantLabel = variant === "foundational" ? "Foundational" : "Rising";

  return (
    <article className={styles.paperCard}>
      <div className={styles.paperHeader}>
        <div>
          <div className={styles.paperBadges}>
            <span className={`${styles.paperBadge} ${styles[`paperBadge-${variant}`]}`}>{variantLabel}</span>
            {paper.type === "review" ? <span className={styles.paperBadgeAlt}>Review</span> : null}
            {badge ? <span className={styles.paperBadgeAlt}>{badge}</span> : null}
            {cluster ? <span className={styles.paperBadgeMuted}>{cluster.label}</span> : null}
          </div>
          <h4 className={styles.paperTitle}>
            <a href={paper.url} target="_blank" rel="noreferrer">
              {paper.title}
            </a>
          </h4>
          <p className={styles.paperMeta}>
            {paper.year} | {paper.citationCount} citations | {paper.citationsPerYear.toFixed(1)}/yr | score {(paper.score * 100).toFixed(0)}
          </p>
          {paper.authors.length ? (
            <p className={styles.paperAuthors}>
              {paper.authors.slice(0, 4).map((a) => a.name).join(", ")}
              {paper.authors.length > 4 ? `, +${paper.authors.length - 4} more` : ""}
            </p>
          ) : null}
        </div>
      </div>
      <button type="button" className={styles.whyToggle} onClick={() => setOpen(!open)}>
        {open ? "Hide why" : "Why this paper?"}
      </button>
      {open ? (
        <ul className={styles.whyList}>
          {reasons.map((r, i) => (
            <li key={i} className={`${styles.whyItem} ${styles[`why-${r.kind}`]}`}>
              {r.text}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
