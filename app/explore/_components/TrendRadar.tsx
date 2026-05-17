"use client";

import type { ClusterTrend } from "@/lib/derive/trend";
import styles from "../explore.module.css";
import { ConfidencePill } from "./ConfidencePill";
import { TrendStatusBadge } from "./TrendStatusBadge";

export function TrendRadar({ trends }: { trends: ClusterTrend[] }) {
  if (!trends.length) {
    return <p className={styles.empty}>No clusters available for this query.</p>;
  }

  return (
    <div className={styles.trendList}>
      {trends.map((trend) => (
        <article key={trend.clusterId} className={styles.trendCard}>
          <header className={styles.trendHeader}>
            <div>
              <h3>{trend.clusterLabel}</h3>
              <p className={styles.trendMeta}>
                {trend.paperCount} papers | {(trend.recentPaperShare * 100).toFixed(0)}% recent
              </p>
            </div>
            <div className={styles.trendBadges}>
              <TrendStatusBadge status={trend.status} label={trend.statusLabel} />
              <ConfidencePill confidence={trend.confidence} />
            </div>
          </header>

          <div className={styles.trendScoreRow}>
            <span className={styles.trendScoreLabel}>Trend score</span>
            <div className={styles.trendBar}>
              <div
                className={`${styles.trendBarFill} ${styles[`status-${trend.status}`]}`}
                style={{ width: `${Math.min(100, trend.trendScore * 100)}%` }}
              />
            </div>
            <span className={styles.trendScoreValue}>{(trend.trendScore * 100).toFixed(0)}</span>
          </div>

          <table className={styles.contributorTable}>
            <thead>
              <tr>
                <th>Signal</th>
                <th>Value</th>
                <th>Weight</th>
                <th>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {trend.contributors.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td>{(c.value * 100).toFixed(0)}%</td>
                  <td>{(c.weight * 100).toFixed(0)}%</td>
                  <td>{(c.contribution * 100).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {trend.whyLines.length ? (
            <div className={styles.whyBlock}>
              <p className={styles.whyTitle}>Why this label</p>
              <ul>
                {trend.whyLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {trend.warnings.length ? (
            <div className={styles.warnBlock}>
              {trend.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
