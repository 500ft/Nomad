"use client";

import { buildRoadmap } from "@/lib/derive/roadmap";
import type { ResearchMapResponse } from "@/lib/types";
import styles from "../explore.module.css";
import { ConfidencePill } from "./ConfidencePill";
import { PaperCard } from "./PaperCard";
import { TrendStatusBadge } from "./TrendStatusBadge";

export function ReadingRoadmap({ map }: { map: ResearchMapResponse }) {
  const roadmap = buildRoadmap(map);

  if (!roadmap.phases.length) {
    return <p className={styles.empty}>Not enough usable papers to build a reading roadmap.</p>;
  }

  return (
    <div className={styles.roadmap}>
      {roadmap.warnings.length ? (
        <div className={styles.roadmapWarnings}>
          {roadmap.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      ) : null}

      {roadmap.phases.map((phase) => (
        <section key={phase.id} className={`${styles.phase} ${styles[`phase-${phase.id}`]}`}>
          <header className={styles.phaseHeader}>
            <div>
              <h3>{phase.title}</h3>
              <p className={styles.phaseSubtitle}>{phase.subtitle}</p>
            </div>
            {phase.trend ? (
              <div className={styles.trendBadges}>
                <TrendStatusBadge status={phase.trend.status} label={phase.trend.statusLabel} />
                <ConfidencePill confidence={phase.trend.confidence} compact />
              </div>
            ) : null}
          </header>

          {phase.papers.length ? (
            <div className={styles.phasePapers}>
              {phase.papers.map((rp) => (
                <PaperCard
                  key={rp.paper.id}
                  paper={rp.paper}
                  variant={rp.variant}
                  cluster={rp.cluster}
                  map={map}
                />
              ))}
            </div>
          ) : null}

          {phase.projects?.length ? (
            <div className={styles.projectGrid}>
              {phase.projects.map((idea) => (
                <article key={idea.title} className={styles.projectCard}>
                  <div className={styles.paperBadges}>
                    {idea.projectType ? <span className={styles.paperBadge}>{idea.projectType}</span> : null}
                    <span className={styles.paperBadge}>{idea.difficulty}</span>
                    <span className={styles.paperBadgeMuted}>{idea.confidence} confidence</span>
                  </div>
                  <h4>{idea.title}</h4>
                  <p>{idea.description}</p>
                  <p className={styles.projectMeta}>
                    <strong>Why now:</strong> {idea.whyNow}
                  </p>
                  <p className={styles.projectMeta}>
                    <strong>First experiment:</strong> {idea.firstExperiment ?? idea.mvpVersion}
                  </p>
                  {idea.distinctivenessSignals?.length ? (
                    <p className={styles.projectMeta}>
                      <strong>Signals:</strong> {idea.distinctivenessSignals.slice(0, 3).join(" • ")}
                    </p>
                  ) : null}
                  <p className={styles.projectMeta}>
                    <strong>Why grounded:</strong> {idea.traceability.evidenceNote}
                  </p>
                  <p className={styles.projectMeta}>
                    <strong>Background:</strong> {idea.requiredBackground.join(" • ")}
                  </p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
