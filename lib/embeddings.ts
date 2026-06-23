import OpenAI from "openai";
import { createHash } from "crypto";

import type { NormalizedWork, ResearchGoal, SemanticSignals } from "./types";

export const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_EMBEDDED_WORKS = 200;
const MAX_TEXT_LENGTH = 2800;
const embeddingCache = new Map<string, number[]>();

export type EmbeddingResult = {
  works: NormalizedWork[];
  signals: SemanticSignals;
};

export function buildQueryText(topic: string, field: string | undefined, goal: ResearchGoal): string {
  return [topic, field || "mechanical engineering", goal].join(" ");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    const aValue = a[index] ?? 0;
    const bValue = b[index] ?? 0;
    dot += aValue * bValue;
    aMagnitude += aValue * aValue;
    bMagnitude += bValue * bValue;
  }

  if (!aMagnitude || !bMagnitude) {
    return 0;
  }

  return (dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude)) + 1) / 2;
}

export function blendRelevance(keywordRelevanceScore: number, semanticRelevanceScore: number | null, judgeGradeScore: number | null = null): number {
  if (judgeGradeScore !== null) {
    const semantic = semanticRelevanceScore ?? keywordRelevanceScore;
    return clamp01(0.55 * judgeGradeScore + 0.3 * keywordRelevanceScore + 0.15 * semantic);
  }

  if (semanticRelevanceScore === null) {
    return keywordRelevanceScore;
  }

  return clamp01(0.65 * keywordRelevanceScore + 0.35 * semanticRelevanceScore);
}

export async function applySemanticRelevance(works: NormalizedWork[], queryText: string, apiKey = process.env.OPENAI_API_KEY): Promise<EmbeddingResult> {
  if (!apiKey || !works.length) {
    return {
      works,
      signals: {
        enabled: false,
        model: null,
        embeddedPaperCount: 0,
        failedPaperCount: works.length
      }
    };
  }

  try {
    const selectedWorks = works.slice(0, MAX_EMBEDDED_WORKS);
    const queryEmbedding = await getEmbedding(`query:${hashText(queryText)}`, queryText, apiKey);
    const uncachedInputs: Array<{ key: string; text: string }> = [];
    const workKeys = selectedWorks.map((work) => {
      const key = `${work.id}:${EMBEDDING_MODEL}:${hashText(work.compactText)}`;
      if (!embeddingCache.has(key)) {
        uncachedInputs.push({ key, text: truncateForEmbedding(work.compactText) });
      }
      return key;
    });

    if (uncachedInputs.length) {
      const client = new OpenAI({ apiKey });
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: uncachedInputs.map((input) => input.text)
      });
      response.data.forEach((item, index) => {
        const key = uncachedInputs[index]?.key;
        if (key) {
          embeddingCache.set(key, item.embedding);
        }
      });
    }

    const selectedIds = new Set(selectedWorks.map((work) => work.id));
    let embeddedPaperCount = 0;
    const enrichedWorks = works.map((work) => {
      if (!selectedIds.has(work.id)) {
        return work;
      }
      const key = workKeys[selectedWorks.findIndex((candidate) => candidate.id === work.id)];
      const paperEmbedding = key ? embeddingCache.get(key) : null;
      if (!paperEmbedding) {
        return work;
      }
      embeddedPaperCount += 1;
      const semanticRelevanceScore = cosineSimilarity(queryEmbedding, paperEmbedding);
      return {
        ...work,
        semanticRelevanceScore,
        finalRelevanceScore: blendRelevance(work.keywordRelevanceScore, semanticRelevanceScore, work.judgeGradeScore),
        relevanceScore: blendRelevance(work.keywordRelevanceScore, semanticRelevanceScore, work.judgeGradeScore),
        embeddingModel: EMBEDDING_MODEL
      };
    });

    return {
      works: enrichedWorks,
      signals: {
        enabled: true,
        model: EMBEDDING_MODEL,
        embeddedPaperCount,
        failedPaperCount: Math.max(0, selectedWorks.length - embeddedPaperCount)
      }
    };
  } catch {
    return {
      works,
      signals: {
        enabled: false,
        model: EMBEDDING_MODEL,
        embeddedPaperCount: 0,
        failedPaperCount: works.length
      }
    };
  }
}

async function getEmbedding(key: string, text: string, apiKey: string): Promise<number[]> {
  const cached = embeddingCache.get(key);
  if (cached) {
    return cached;
  }

  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: truncateForEmbedding(text)
  });
  const embedding = response.data[0]?.embedding ?? [];
  embeddingCache.set(key, embedding);
  return embedding;
}

function truncateForEmbedding(text: string): string {
  return text.slice(0, MAX_TEXT_LENGTH);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
