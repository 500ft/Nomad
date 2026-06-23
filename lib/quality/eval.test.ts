import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenAlexWork, ResearchMapRequest } from "../types";
import { buildV2ResearchMap } from "./v2-pipeline";

const FIXTURE_DIR = join(__dirname, "..", "..", "test-fixtures", "openalex");

type Fixture = {
  request: ResearchMapRequest;
  capturedAt: string;
  works: OpenAlexWork[];
};

function loadFixture(slug: string): Fixture | null {
  const path = join(FIXTURE_DIR, `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

type BuiltV2Map = Awaited<ReturnType<typeof buildV2ResearchMap>>;

function topTitles(map: BuiltV2Map): string[] {
  return map.foundationalPapers.map((p) => p.title.toLowerCase());
}

describe("v2 regression suite — 5 audit topics", () => {
  const fixturesAvailable = existsSync(FIXTURE_DIR) && readdirSync(FIXTURE_DIR).some((f) => f.endsWith(".json"));
  const maybeIt = fixturesAvailable ? it : it.skip;

  maybeIt("ai-mech-design: rejects hotel/hospitality/marketing drift from foundational picks", async () => {
    const fx = loadFixture("ai-mech-design");
    if (!fx) return;
    const map = await buildV2ResearchMap(fx.request, fx.works);
    const titles = topTitles(map);
    const driftHits = titles.filter((t) =>
      /\bhotel|hospitality|tourism|customer service|marketing\b/i.test(t)
    );
    expect(driftHits, `drift papers in foundational: ${driftHits.join(" | ")}`).toEqual([]);
    expect(map.qualityReport.driftRejections.length).toBeGreaterThan(0);
  });

  maybeIt("battery-thermal: splits the mega-cluster into 2+ subclusters", async () => {
    const fx = loadFixture("battery-thermal");
    if (!fx) return;
    const map = await buildV2ResearchMap(fx.request, fx.works);
    expect(map.qualityReport.splitClusters).toBeGreaterThan(0);
    expect(map.qualityReport.subclustersCreated).toBeGreaterThanOrEqual(2);
    const splitChildLabels = map.qualityReport.splits.flatMap((s) => s.childLabels);
    expect(splitChildLabels.length).toBeGreaterThanOrEqual(2);
  });

  maybeIt("soft-robotics: keeps Mariana Trench / Magnetic Soft / Hydrogel papers in foundational", async () => {
    const fx = loadFixture("soft-robotics");
    if (!fx) return;
    const map = await buildV2ResearchMap(fx.request, fx.works);
    const titles = topTitles(map);
    const expected = ["mariana trench", "magnetic soft", "hydrogel"];
    const hit = expected.some((needle) => titles.some((t) => t.includes(needle)));
    expect(hit, `expected at least one canonical paper, got: ${titles.slice(0, 3).join(" | ")}`).toBe(true);
  });

  maybeIt("am-defect: foundational picks stay in AM defect detection territory", async () => {
    const fx = loadFixture("am-defect");
    if (!fx) return;
    const map = await buildV2ResearchMap(fx.request, fx.works);
    const titles = topTitles(map);
    const onTopic = titles.filter((t) => /(additive|defect|laser|powder bed|3d print)/i.test(t));
    expect(onTopic.length).toBeGreaterThanOrEqual(Math.ceil(titles.length / 2));
  });

  maybeIt("6g-channel: foundational picks include channel/RIS/terahertz papers", async () => {
    const fx = loadFixture("6g-channel");
    if (!fx) return;
    const map = await buildV2ResearchMap(fx.request, fx.works);
    const titles = topTitles(map);
    const onTopic = titles.filter((t) => /(channel|ris|terahertz|mimo|6g)/i.test(t));
    expect(onTopic.length).toBeGreaterThanOrEqual(Math.ceil(titles.length / 2));
  });

  maybeIt("relevance pipeline rejects ≥1 paper across all topics (sanity)", async () => {
    const slugs = ["soft-robotics", "battery-thermal", "ai-mech-design", "am-defect", "6g-channel"];
    let totalRejected = 0;
    for (const slug of slugs) {
      const fx = loadFixture(slug);
      if (!fx) continue;
      const map = await buildV2ResearchMap(fx.request, fx.works);
      totalRejected += map.qualityReport.papersRejected;
    }
    expect(totalRejected).toBeGreaterThan(0);
  });
});
