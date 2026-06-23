import OpenAI from "openai";
import { createHash } from "crypto";

import type { JudgeSignals, NormalizedWork, ResearchMapRequest } from "./types";

export const JUDGE_MODEL = "gpt-4o-mini";
export const JUDGE_PROMPT_VERSION = "abstract-v1";
export const JUDGE_CANDIDATE_LIMIT = 40;
export const JUDGE_BATCH_SIZE = 8;
const MAX_JUDGE_ABSTRACT_CHARS = 2400;

export type JudgeVerdict = {
  workId: string;
  onTopic: boolean;
  grade: 0 | 1 | 2 | 3;
  about: string;
  reason: string;
};

export type JudgeWork = Pick<
  NormalizedWork,
  "id" | "title" | "abstractText" | "primaryTopic" | "topics" | "keywords" | "preGateScore" | "finalRelevanceScore"
>;

export type JudgeInput = {
  request: ResearchMapRequest;
  works: JudgeWork[];
};

export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict[]>;

export type JudgeCache = {
  get(key: string): JudgeVerdict | undefined;
  set(key: string, verdict: JudgeVerdict): void;
};

export type ApplyJudgeOptions = {
  judge?: JudgeFn;
  cache?: JudgeCache;
  apiKey?: string;
  enabled?: boolean;
};

export type JudgeResult = {
  works: NormalizedWork[];
  signals: JudgeSignals;
};

export class MemoryJudgeCache implements JudgeCache {
  private readonly values = new Map<string, JudgeVerdict>();

  get(key: string): JudgeVerdict | undefined {
    return this.values.get(key);
  }

  set(key: string, verdict: JudgeVerdict): void {
    this.values.set(key, verdict);
  }
}

const defaultJudgeCache = new MemoryJudgeCache();

export async function applyRelevanceJudge(
  request: ResearchMapRequest,
  works: NormalizedWork[],
  options: ApplyJudgeOptions = {}
): Promise<JudgeResult> {
  const enabled = options.enabled ?? isJudgeEnabled();
  const judge = options.judge ?? (enabled ? defaultRelevanceJudge : null);
  const cache = options.cache ?? defaultJudgeCache;

  if (!enabled || !judge || !works.length) {
    return {
      works,
      signals: emptySignals(false)
    };
  }

  const candidates = works
    .slice()
    .sort((a, b) => judgeCandidateScore(b) - judgeCandidateScore(a))
    .slice(0, JUDGE_CANDIDATE_LIMIT);
  const unjudgedNoAbstractCount = candidates.filter((work) => !work.hasAbstract || !work.abstractText).length;
  const judgeable = candidates.filter((work) => work.hasAbstract && work.abstractText);
  const verdicts = new Map<string, JudgeVerdict>();
  const uncached: NormalizedWork[] = [];

  for (const work of judgeable) {
    const key = buildJudgeCacheKey(request, work);
    const cached = cache.get(key);
    if (cached) {
      verdicts.set(work.id, cached);
    } else {
      uncached.push(work);
    }
  }

  let failedBatchCount = 0;
  for (let index = 0; index < uncached.length; index += JUDGE_BATCH_SIZE) {
    const batch = uncached.slice(index, index + JUDGE_BATCH_SIZE);
    try {
      const batchVerdicts = await judge({
        request,
        works: batch.map(toJudgeWork)
      });
      for (const verdict of batchVerdicts) {
        const work = batch.find((candidate) => candidate.id === verdict.workId);
        if (!work || !isValidGrade(verdict.grade)) {
          continue;
        }
        const normalizedVerdict = {
          ...verdict,
          onTopic: verdict.grade > 0
        };
        cache.set(buildJudgeCacheKey(request, work), normalizedVerdict);
        verdicts.set(work.id, normalizedVerdict);
      }
    } catch {
      failedBatchCount += 1;
    }
  }

  const enrichedWorks = works.map((work) => {
    const verdict = verdicts.get(work.id);
    if (!verdict) {
      return work;
    }
    return {
      ...work,
      judged: true,
      judgeGrade: verdict.grade,
      judgeGradeScore: verdict.grade / 3,
      judgeOnTopic: verdict.grade > 0,
      judgeAbout: verdict.about,
      judgeReason: verdict.reason
    };
  });

  return {
    works: enrichedWorks,
    signals: {
      enabled: true,
      model: JUDGE_MODEL,
      judgedCount: verdicts.size,
      filteredOffTopicCount: 0,
      unjudgedNoAbstractCount,
      failedBatchCount
    }
  };
}

export function buildJudgeCacheKey(request: ResearchMapRequest, work: Pick<NormalizedWork, "id" | "abstractText">): string {
  return hashText(
    [
      work.id,
      hashText(work.abstractText ?? ""),
      request.topic,
      request.field ?? "mechanical engineering",
      request.goal,
      JUDGE_MODEL,
      JUDGE_PROMPT_VERSION
    ].join("|")
  );
}

async function defaultRelevanceJudge(input: JudgeInput): Promise<JudgeVerdict[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !input.works.length) {
    return [];
  }

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict academic relevance judge. Grade whether each paper's core contribution addresses the user query. Shared terminology with a different application should be grade 0 or 1. Return JSON with a top-level verdicts array."
      },
      {
        role: "user",
        content: JSON.stringify({
          promptVersion: JUDGE_PROMPT_VERSION,
          query: input.request,
          scale: {
            0: "off-topic",
            1: "tangential",
            2: "relevant",
            3: "core"
          },
          papers: input.works.map((work) => ({
            workId: work.id,
            title: work.title,
            abstract: (work.abstractText ?? "").slice(0, MAX_JUDGE_ABSTRACT_CHARS),
            primaryTopic: work.primaryTopic?.display_name ?? null,
            topics: work.topics.map((topic) => topic.display_name).filter(Boolean),
            keywords: work.keywords
          }))
        })
      }
    ]
  });

  const content = response.choices[0]?.message.content ?? "{}";
  const parsed = JSON.parse(content) as { verdicts?: JudgeVerdict[] };
  return Array.isArray(parsed.verdicts) ? parsed.verdicts.filter((verdict) => isValidGrade(verdict.grade)) : [];
}

function toJudgeWork(work: NormalizedWork): JudgeWork {
  return {
    id: work.id,
    title: work.title,
    abstractText: work.abstractText,
    primaryTopic: work.primaryTopic,
    topics: work.topics,
    keywords: work.keywords,
    preGateScore: work.preGateScore,
    finalRelevanceScore: work.finalRelevanceScore
  };
}

function judgeCandidateScore(work: NormalizedWork): number {
  const driftPenalty = (work.preGateDriftDomains ?? []).length ? 0.15 : 0;
  return Math.max(0, 0.55 * (work.preGateScore ?? work.finalRelevanceScore) + 0.45 * work.finalRelevanceScore - driftPenalty);
}

function isJudgeEnabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.RELEVANCE_JUDGE ?? "").toLowerCase());
}

function emptySignals(enabled: boolean): JudgeSignals {
  return {
    enabled,
    model: enabled ? JUDGE_MODEL : null,
    judgedCount: 0,
    filteredOffTopicCount: 0,
    unjudgedNoAbstractCount: 0,
    failedBatchCount: 0
  };
}

function isValidGrade(grade: unknown): grade is 0 | 1 | 2 | 3 {
  return grade === 0 || grade === 1 || grade === 2 || grade === 3;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
