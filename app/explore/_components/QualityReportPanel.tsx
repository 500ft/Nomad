"use client";

import type { QualityReport } from "@/lib/quality/v2-types";
import styles from "../explore.module.css";

export function QualityReportPanel({ report }: { report: QualityReport }) {
  return (
    <section className={styles.qualityPanel}>
      <header className={styles.qualityHeader}>
        <h3>Quality Report</h3>
        <span className={styles.qualityBadge}>v2 engine</span>
      </header>

      <div className={styles.qualityGrid}>
        <Stat label="Papers fetched" value={report.papersFetched} />
        <Stat label="Kept after filter" value={report.papersKept} positive={report.papersKept > 0} />
        <Stat label="Rejected" value={report.papersRejected} negative={report.papersRejected > 0} />
        <Stat label="With warnings" value={report.papersWarned} />
        <Stat
          label="Largest original cluster"
          value={`${(report.largestOriginalClusterShare * 100).toFixed(0)}%`}
        />
        <Stat label="Mega-clusters split" value={report.splitClusters} />
        <Stat label="Subclusters created" value={report.subclustersCreated} />
      </div>

      {Object.entries(report.rejectionReasons).some(([, n]) => n > 0) ? (
        <div className={styles.qualitySubsection}>
          <p className={styles.qualitySubLabel}>Rejection reasons</p>
          <div className={styles.reasonChips}>
            {Object.entries(report.rejectionReasons)
              .filter(([, n]) => n > 0)
              .map(([reason, n]) => (
                <span key={reason} className={styles.reasonChip}>
                  {humanReason(reason)}: {n}
                </span>
              ))}
          </div>
        </div>
      ) : null}

      {report.driftRejections.length ? (
        <div className={styles.qualitySubsection}>
          <p className={styles.qualitySubLabel}>Drift-rejected papers (top {report.driftRejections.length})</p>
          <ul className={styles.driftList}>
            {report.driftRejections.map((d, i) => (
              <li key={i}>
                <span className={styles.driftDomains}>[{d.domains.join(", ")}]</span>{" "}
                <span className={styles.driftTitle}>{d.title}</span>{" "}
                <span className={styles.driftCosine}>cosine {d.cosine.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.splits.length ? (
        <div className={styles.qualitySubsection}>
          <p className={styles.qualitySubLabel}>Cluster splits</p>
          <ul className={styles.splitList}>
            {report.splits.map((s, i) => (
              <li key={i}>
                <strong>{s.parentLabel}</strong> → {s.childLabels.length} subclusters
                <ul>
                  {s.childLabels.map((label, j) => (
                    <li key={j}>{label}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  positive,
  negative
}: {
  label: string;
  value: string | number;
  positive?: boolean;
  negative?: boolean;
}) {
  const cls = positive ? styles.statPositive : negative ? styles.statNegative : "";
  return (
    <div className={`${styles.stat} ${cls}`}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

function humanReason(reason: string): string {
  switch (reason) {
    case "low-cosine-similarity":
      return "Low relevance";
    case "drift-domain-conflict":
      return "Off-domain drift";
    case "no-content":
      return "No content";
    default:
      return reason;
  }
}
