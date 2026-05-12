import { describe, expect, it } from "vitest";

import { buildOpenAlexWorksUrl } from "./openalex";
import { buildResearchMap, computeMapConfidence, normalizeWorks, scoreWorks } from "./scoring";
import type { OpenAlexWork, ResearchMapRequest } from "./types";

const request: ResearchMapRequest = {
  topic: "machine learning for HVAC CFD",
  experienceLevel: "beginner",
  goal: "build-project",
  fromYear: 2020,
  toYear: 2026
};

function work(id: string, overrides: Partial<OpenAlexWork> = {}): OpenAlexWork {
  return {
    id: `https://openalex.org/${id}`,
    doi: `https://doi.org/10.1234/${id}`,
    display_name: `Machine learning HVAC CFD study ${id}`,
    publication_year: 2024,
    publication_date: "2024-01-01",
    relevance_score: 80,
    cited_by_count: 25,
    citation_normalized_percentile: { value: 0.7 },
    authorships: [
      {
        author: {
          id: "https://openalex.org/A1",
          display_name: "Ada Researcher"
        }
      }
    ],
    primary_topic: {
      id: "https://openalex.org/T1",
      display_name: "Building airflow simulation"
    },
    topics: [
      {
        id: "https://openalex.org/T2",
        display_name: "Computational fluid dynamics"
      }
    ],
    keywords: [{ display_name: "HVAC" }],
    type: "article",
    is_retracted: false,
    abstract_inverted_index: { machine: [0], learning: [1] },
    ...overrides
  };
}

describe("OpenAlex query construction", () => {
  it("filters upstream and selects explicit fields", () => {
    const url = buildOpenAlexWorksUrl(request);

    expect(url).toContain("search=machine+learning+for+HVAC+CFD");
    expect(url).toContain("from_publication_date%3A2020-01-01");
    expect(url).toContain("to_publication_date%3A2026-12-31");
    expect(url).toContain("is_retracted%3Afalse");
    expect(url).toContain("select=");
    expect(url).toContain("per-page=200");
  });
});

describe("normalization and scoring", () => {
  it("deduplicates by DOI and excludes retracted works", () => {
    const works = [
      work("W1"),
      work("W2", { doi: "https://doi.org/10.1234/W1" }),
      work("W3", { is_retracted: true })
    ];

    const result = normalizeWorks(request, works);

    expect(result.works).toHaveLength(1);
    expect(result.dedupedCount).toBe(1);
    expect(result.excludedRetractedCount).toBe(1);
  });

  it("normalizes scores to 0-1 before ranking", () => {
    const scored = scoreWorks(request, [
      ...normalizeWorks(request, [
        work("W1", { cited_by_count: 5000, publication_year: 2020 }),
        work("W2", { cited_by_count: 10, publication_year: 2026 })
      ]).works
    ]);

    for (const item of scored) {
      expect(item.logCitationScore).toBeGreaterThanOrEqual(0);
      expect(item.logCitationScore).toBeLessThanOrEqual(1);
      expect(item.foundationalScore).toBeGreaterThanOrEqual(0);
      expect(item.foundationalScore).toBeLessThanOrEqual(1);
      expect(item.recentInfluenceScore).toBeGreaterThanOrEqual(0);
      expect(item.recentInfluenceScore).toBeLessThanOrEqual(1);
    }
  });

  it("uses computed confidence thresholds", () => {
    expect(computeMapConfidence(75, 0.55)).toBe("strong");
    expect(computeMapConfidence(25, 0.2)).toBe("moderate");
    expect(computeMapConfidence(24, 0.9)).toBe("sparse");
  });
});

describe("research map output", () => {
  it("returns the six sections and traceable project ideas", () => {
    const works = Array.from({ length: 35 }, (_, index) =>
      work(`W${index}`, {
        display_name: `Machine learning HVAC CFD paper ${index}`,
        cited_by_count: 10 + index,
        publication_year: 2020 + (index % 6),
        authorships: [
          {
            author: {
              id: index % 2 ? "https://openalex.org/A1" : "https://openalex.org/A2",
              display_name: index % 2 ? "Ada Researcher" : "Grace Engineer"
            }
          }
        ],
        primary_topic: {
          id: index % 2 ? "https://openalex.org/T1" : "https://openalex.org/T2",
          display_name: index % 2 ? "Building airflow simulation" : "Reduced order modeling"
        }
      })
    );

    const map = buildResearchMap(request, works);

    expect(map.foundationalPapers.length).toBeGreaterThan(0);
    expect(map.recentInfluencePapers.length).toBeGreaterThan(0);
    expect(map.people.length).toBeGreaterThan(0);
    expect(map.clusters.length).toBeGreaterThan(0);
    expect(map.citationSignals.totalUsableWorks).toBeGreaterThan(0);
    expect(map.citationSignals.topClusterByPaperCount).toBeTruthy();
    expect(map.projectIdeas.length).toBeGreaterThan(0);
    expect(map.evidence.length).toBeGreaterThan(0);
    expect(map.query.field).toBe("mechanical engineering");
    expect(map.projectIdeas[0].supportingPaperIds.length).toBeGreaterThan(0);
    expect(map.projectIdeas[0].supportingClusterIds.length).toBeGreaterThan(0);
    expect(map.projectIdeas[0].reasonCodes.length).toBeGreaterThan(0);
    expect(map.people[0].id).toContain("https://openalex.org/A");
  });
});
