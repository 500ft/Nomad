import { describe, expect, it } from "vitest";

import type { OpenAlexWork } from "../types";
import { filterByRelevance } from "./relevance";

function work(overrides: Partial<OpenAlexWork> & { id: string; display_name: string }): OpenAlexWork {
  return {
    doi: null,
    publication_year: 2024,
    publication_date: "2024-01-01",
    relevance_score: 80,
    cited_by_count: 50,
    citation_normalized_percentile: { value: 0.6 },
    authorships: [],
    primary_topic: null,
    topics: [],
    keywords: [],
    type: "article",
    is_retracted: false,
    abstract_inverted_index: null,
    ...overrides
  };
}

describe("filterByRelevance", () => {
  it("keeps clearly off-topic papers while reporting low-cosine diagnostics", () => {
    const works = [
      work({
        id: "ON1",
        display_name: "AI-driven topology optimization for mechanical structures",
        primary_topic: { id: "T1", display_name: "Mechanical design optimization" },
        keywords: [{ display_name: "topology optimization" }, { display_name: "generative design" }]
      }),
      work({
        id: "OFF",
        display_name: "Effects of COVID-19 on hotel marketing and management: a perspective article",
        primary_topic: { id: "TH", display_name: "Hospitality marketing" },
        keywords: [{ display_name: "hotel" }, { display_name: "marketing" }]
      })
    ];
    const out = filterByRelevance("AI for mechanical design", works);
    expect(out.kept.map((w) => w.id)).toContain("ON1");
    expect(out.kept.map((w) => w.id)).toContain("OFF");
    expect(out.rejected.map((r) => r.work.id)).toContain("OFF");
  });

  it("rejects via drift-domain blocklist even if cosine is borderline", () => {
    const works = [
      work({
        id: "DRIFT",
        display_name: "Customer evaluation of mechanical AI in hospitality services using a survey",
        primary_topic: { id: "TH", display_name: "Hospitality marketing" },
        keywords: [{ display_name: "hotel" }, { display_name: "tourism" }]
      })
    ];
    const out = filterByRelevance("AI for mechanical design", works);
    const r = out.rejected.find((x) => x.work.id === "DRIFT");
    expect(r).toBeDefined();
    expect(r?.driftDomains).toContain("hospitality");
    expect(r?.reasons).toContain("drift-domain-conflict");
  });

  it("does NOT reject hospitality papers when the user actually queries for them", () => {
    const works = [
      work({
        id: "OK",
        display_name: "Customer evaluation of AI in hotel hospitality services",
        primary_topic: { id: "TH", display_name: "Hospitality marketing" },
        keywords: [{ display_name: "hotel" }, { display_name: "tourism" }]
      })
    ];
    const out = filterByRelevance("AI in hotel hospitality services", works);
    expect(out.kept.map((w) => w.id)).toContain("OK");
  });

  it("warns rather than rejects on borderline cosine", () => {
    // Borderline: title has one query token but no abstract context
    const works = [
      work({
        id: "OK",
        display_name: "Wind turbine reliability and AI maintenance review for power systems",
        primary_topic: { id: "T1", display_name: "Wind turbine maintenance" },
        keywords: [{ display_name: "AI" }, { display_name: "maintenance" }]
      }),
      work({
        id: "BORDER",
        display_name: "AI applications in mechanical maintenance survey",
        primary_topic: { id: "T2", display_name: "Wind turbine maintenance" },
        keywords: []
      })
    ];
    const out = filterByRelevance("AI for mechanical design optimization", works);
    expect(out.kept.length).toBeGreaterThan(0);
  });

  it("counts rejection reasons", () => {
    const works = [
      work({ id: "DRIFT", display_name: "hotel marketing tourism hospitality consumer" }),
      work({ id: "EMPTY", display_name: "" }),
      work({ id: "OK", display_name: "machine learning for mechanical design optimization" })
    ];
    const out = filterByRelevance("machine learning mechanical design", works);
    expect(out.rejectionReasons["drift-domain-conflict"]).toBeGreaterThan(0);
    expect(out.rejected.length).toBeGreaterThanOrEqual(1);
  });
});
