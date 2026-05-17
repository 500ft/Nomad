"use client";

import styles from "../explore.module.css";

export type Example = {
  topic: string;
  experienceLevel: "beginner" | "intermediate" | "technical";
  goal: "read" | "publish" | "build-project" | "find-researchers";
  fromYear: number;
  toYear: number;
};

const CURRENT_YEAR = new Date().getFullYear();

export const EXAMPLES: Example[] = [
  { topic: "Soft robotics", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: CURRENT_YEAR },
  { topic: "battery thermal management", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: CURRENT_YEAR },
  { topic: "additive manufacturing defect detection", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: CURRENT_YEAR },
  { topic: "wireless channel modeling for 6G", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: CURRENT_YEAR },
  { topic: "AI for mechanical design", experienceLevel: "beginner", goal: "read", fromYear: 2020, toYear: CURRENT_YEAR }
];

export function ExampleTopics({ onPick }: { onPick: (example: Example) => void }) {
  return (
    <div className={styles.examples}>
      <span className={styles.examplesLabel}>Try an example:</span>
      <div className={styles.examplesRow}>
        {EXAMPLES.map((ex) => (
          <button key={ex.topic} type="button" className={styles.exampleChip} onClick={() => onPick(ex)}>
            {ex.topic}
          </button>
        ))}
      </div>
    </div>
  );
}
