import type { ResearchMapResponse } from "../types";
import type { V2ResearchMapResponse } from "../quality/v2-types";

const STORAGE_KEY = "nomad:research-map-cache:v2";
const TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export type CacheKey = {
  topic: string;
  field?: string;
  experienceLevel: string;
  goal: string;
  fromYear: number;
  toYear: number;
  engine?: string;
};

export type CacheEntry = {
  key: string;
  cachedAt: number;
  result: CachedResearchMapResponse;
};

export type CachedResearchMapResponse = ResearchMapResponse | V2ResearchMapResponse;

function keyString(k: CacheKey): string {
  return `${k.topic.trim().toLowerCase()}|${(k.field ?? "mechanical engineering").trim().toLowerCase()}|${k.experienceLevel}|${k.goal}|${k.fromYear}|${k.toYear}|${k.engine ?? "v1"}`;
}

function read(): Record<string, CacheEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function write(entries: Record<string, CacheEntry>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* quota or serialization — drop silently */
  }
}

export function getCached<T extends CachedResearchMapResponse = CachedResearchMapResponse>(k: CacheKey): T | null {
  const entries = read();
  const entry = entries[keyString(k)];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) return null;
  if (!hasQueryFocusSuggestions(entry.result)) return null;
  return entry.result as T;
}

export function setCached(k: CacheKey, result: CachedResearchMapResponse): void {
  const entries = read();
  entries[keyString(k)] = { key: keyString(k), cachedAt: Date.now(), result };
  write(entries);
}

function hasQueryFocusSuggestions(result: CachedResearchMapResponse): boolean {
  return Array.isArray(result.queryFocus?.suggestions);
}
