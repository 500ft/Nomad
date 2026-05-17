import type { TrendConfidence } from "@/lib/derive/trend";
import styles from "../explore.module.css";

const TEXT: Record<TrendConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence"
};

export function ConfidencePill({ confidence, compact }: { confidence: TrendConfidence; compact?: boolean }) {
  return (
    <span className={`${styles.pill} ${styles[`confidence-${confidence}`]}`}>
      {compact ? confidence.toUpperCase() : TEXT[confidence]}
    </span>
  );
}
