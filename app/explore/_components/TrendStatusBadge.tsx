import type { TrendStatus } from "@/lib/derive/trend";
import styles from "../explore.module.css";

export function TrendStatusBadge({ status, label }: { status: TrendStatus; label: string }) {
  return <span className={`${styles.statusBadge} ${styles[`status-${status}`]}`}>{label}</span>;
}
