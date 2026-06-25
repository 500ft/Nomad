import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenAlexCitationHistoryUrl,
  buildOpenAlexWorksByIdsUrl,
  buildOpenAlexWorksUrl,
  buildSearchVariants,
  dedupeWorksById,
  fetchOpenAlexWorks
} from "./openalex";
import type { OpenAlexWork, ResearchMapRequest } from "./types";

const baseRequest: ResearchMapRequest = {
  topic: "machine learning for battery thermal management",
  field: "mechanical engineering",
  experienceLevel: "beginner",
  goal: "build-project",
  fromYear: 2020,
  toYear: 2026
};

function work(id: string, overrides: Partial<OpenAlexWork> = {}): OpenAlexWork {
  return {
    id: `https://openalex.org/${id}`,
    display_name: `Study ${id}`,
    publication_year: 2024,
    cited_by_count: 10,
    ...overrides
  };
}

describe("buildSearchVariants", () => {
  it("always issues the verbatim topic first", () => {
    const variants = buildSearchVariants(baseRequest);
    expect(variants[0]).toBe(baseRequest.topic);
  });

  it("adds field-scoped and core-term variants, deduped and capped", () => {
    const variants = buildSearchVariants(baseRequest);
    expect(variants).toContain("machine learning for battery thermal management mechanical engineering");
    // Core-term variant strips the connective "for".
    expect(variants).toContain("machine learning battery thermal management");
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.length).toBeLessThanOrEqual(3);
  });

  it("does not emit a redundant core-term variant when the topic has no stop words", () => {
    const variants = buildSearchVariants({ ...baseRequest, field: undefined, topic: "soft robotics grippers" });
    expect(variants).toEqual(["soft robotics grippers"]);
  });
});

describe("dedupeWorksById", () => {
  it("keeps the first occurrence of each normalized work id", () => {
    const merged = dedupeWorksById([
      work("W1", { display_name: "first" }),
      work("W2"),
      // Same work, full-URL vs duplicate URL form -> normalizes to W1 and is dropped.
      work("W1", { display_name: "second" })
    ]);
    expect(merged.map((w) => w.id)).toEqual(["https://openalex.org/W1", "https://openalex.org/W2"]);
    expect(merged[0].display_name).toBe("first");
  });

  it("retains works that have no id rather than collapsing them", () => {
    const merged = dedupeWorksById([
      { display_name: "no-id-a" } as OpenAlexWork,
      { display_name: "no-id-b" } as OpenAlexWork
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe("OpenAlex polite-pool mailto", () => {
  const ORIGINAL_MAILTO = process.env.OPENALEX_MAILTO;

  afterEach(() => {
    if (ORIGINAL_MAILTO === undefined) {
      delete process.env.OPENALEX_MAILTO;
    } else {
      process.env.OPENALEX_MAILTO = ORIGINAL_MAILTO;
    }
  });

  it("omits mailto from every builder when OPENALEX_MAILTO is unset", () => {
    delete process.env.OPENALEX_MAILTO;
    expect(buildOpenAlexWorksUrl(baseRequest)).not.toContain("mailto");
    expect(buildOpenAlexWorksByIdsUrl(["W1"])).not.toContain("mailto");
    expect(buildOpenAlexCitationHistoryUrl("W1")).not.toContain("mailto");
  });

  it("adds mailto to every builder when OPENALEX_MAILTO is set", () => {
    process.env.OPENALEX_MAILTO = "nomad@example.com";
    expect(buildOpenAlexWorksUrl(baseRequest)).toContain("mailto=nomad%40example.com");
    expect(buildOpenAlexWorksByIdsUrl(["W1"])).toContain("mailto=nomad%40example.com");
    expect(buildOpenAlexCitationHistoryUrl("W1")).toContain("mailto=nomad%40example.com");
  });
});

describe("fetchOpenAlexWorks recall", () => {
  beforeEach(() => {
    delete process.env.OPENALEX_MAILTO;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("queries multiple variants and dedupes overlapping works by id", async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      // Overlap W1 across pages; each variant also returns a unique work.
      const unique = `W${calledUrls.length}0`;
      const results = [work("W1"), work(unique)];
      return new Response(JSON.stringify({ results }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Unique topic (with a stop word "for") avoids the module-level works cache colliding with
    // other tests and yields three distinct variants: verbatim, field-scoped, and core-terms.
    const works = await fetchOpenAlexWorks({ ...baseRequest, topic: "recall for variant dedupe probe alpha" });

    // 3 variants -> 3 fetches (verbatim, field-scoped, core-terms).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(calledUrls.every((u) => u.startsWith("https://api.openalex.org/works"))).toBe(true);
    // W1 appears once despite being returned by every page.
    const ids = works.map((w) => w.id);
    expect(ids.filter((id) => id === "https://openalex.org/W1")).toHaveLength(1);
    // Unique works from each page are preserved.
    expect(ids).toContain("https://openalex.org/W10");
    expect(works.length).toBeGreaterThan(1);
  });

  it("attaches mailto to live requests when configured", async () => {
    process.env.OPENALEX_MAILTO = "polite@nomad.dev";
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calledUrls.push(String(input));
      return new Response(JSON.stringify({ results: [work("W9")] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenAlexWorks({ ...baseRequest, topic: "recall variant dedupe probe beta" });

    expect(calledUrls.length).toBeGreaterThan(0);
    expect(calledUrls.every((u) => u.includes("mailto=polite%40nomad.dev"))).toBe(true);
  });
});
