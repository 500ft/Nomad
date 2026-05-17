import { describe, expect, it } from "vitest";

import { buildQueryFocusSuggestions, cleanSuggestion } from "./query-focus";

function normalizedTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hasRepeatedPhrase(text: string, size: number): boolean {
  const tokens = normalizedTokens(text);
  const seen = new Set<string>();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    const phrase = tokens.slice(index, index + size).join(" ");
    if (seen.has(phrase)) return true;
    seen.add(phrase);
  }
  return false;
}

function hasRepeatedAdjacentToken(text: string): boolean {
  const tokens = normalizedTokens(text);
  return tokens.some((token, index) => index > 0 && token === tokens[index - 1]);
}

describe("cleanSuggestion", () => {
  it("collapses repeated phrase loops from pasted suggestions", () => {
    const cleaned = cleanSuggestion(
      "machine learning for HVAC CFD thermal comfort optimization thermal comfort optimization thermal comfort optimization"
    );

    expect(cleaned).not.toContain("thermal comfort optimization thermal comfort optimization");
  });

  it("collapses adjacent repeated single tokens", () => {
    expect(cleanSuggestion("HVAC HVAC CFD CFD airflow airflow prediction")).toBe("HVAC CFD airflow prediction");
  });

  it("collapses adjacent repeated multi-word phrases while preserving first casing", () => {
    expect(cleanSuggestion("machine learning machine learning HVAC CFD")).toBe("machine learning HVAC CFD");
  });
});

describe("buildQueryFocusSuggestions", () => {
  it("returns stable clean HVAC suggestions for a pasted bad query", () => {
    expect(
      buildQueryFocusSuggestions(
        "machine learning for HVAC CFD thermal comfort optimization thermal comfort optimization thermal comfort optimization"
      )
    ).toEqual([
      "machine learning surrogate modeling for HVAC airflow prediction",
      "HVAC diffuser airflow prediction with CFD validation",
      "CFD modeling for room ventilation pressure loss"
    ]);
  });

  it("returns stable robotics-specific suggestions", () => {
    expect(buildQueryFocusSuggestions("robotics")).toEqual([
      "robotics force control for gripper design",
      "robotics actuator design for compliant manipulation",
      "soft robotics grippers for delicate object manipulation"
    ]);
  });

  it("returns stable battery-specific suggestions", () => {
    expect(buildQueryFocusSuggestions("battery thermal management")).toEqual([
      "temperature uniformity prediction for battery packs",
      "battery thermal management cooling plate optimization",
      "heat generation modeling for lithium ion battery cells"
    ]);
  });

  it("returns stable generic mechanical-engineering suggestions", () => {
    expect(buildQueryFocusSuggestions("composite material fatigue")).toEqual([
      "composite fatigue life prediction",
      "fiber reinforced composite delamination modeling",
      "composite materials fatigue testing methods"
    ]);
  });

  it("keeps every suggestion under 12 meaningful tokens and free of phrase loops", () => {
    const suggestions = buildQueryFocusSuggestions(
      "machine learning for HVAC CFD thermal comfort optimization thermal comfort optimization thermal comfort optimization"
    );

    for (const suggestion of suggestions) {
      expect(normalizedTokens(suggestion).length).toBeLessThanOrEqual(12);
      expect(hasRepeatedAdjacentToken(suggestion)).toBe(false);
      for (const size of [2, 3, 4, 5]) {
        expect(hasRepeatedPhrase(suggestion, size)).toBe(false);
      }
    }
  });
});
