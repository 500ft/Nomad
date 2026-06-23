import type {
  AuthorSummary,
  CitationNetworkSignals,
  CitationHistoryResult,
  Confidence,
  DataQuality,
  EvidenceItem,
  EvidenceType,
  ExcludedPaper,
  JudgeSignals,
  NormalizedWork,
  OpenAlexTopic,
  OpenAlexWork,
  PaperRecommendation,
  ProjectIdea,
  QueryFocus,
  ResearchMapRequest,
  ResearchMapResponse,
  ResearchDirectionSummary,
  ResearcherRecommendation,
  SharedReferenceEvidence,
  ScoreContribution,
  SummarySignal,
  TopicCluster
} from "./types";
import { applySemanticRelevance, blendRelevance, buildQueryText } from "./embeddings";
import { buildCitationHistoryFromCountsByYear, fetchCitationHistoryForWorks, fetchOpenAlexWorksByIds, normalizeOpenAlexWorkId } from "./openalex";
import { applyRelevanceJudge, type JudgeCache, type JudgeFn } from "./relevance-judge";
import { filterByRelevance, type RelevanceSummary } from "./quality/relevance";
import { buildQueryFocusSuggestions } from "./query-focus";

const FOUNDATIONAL_LIMIT = 5;
const WATCH_NOW_LIMIT = 5;
const PEOPLE_LIMIT = 5;
const CLUSTER_LIMIT = 6;
const RELEVANCE_SEED_LIMIT = 5;
const REQUEST_BUDGET_MAX = 7;
const INITIAL_OPENALEX_REQUESTS = 1;
const SHARED_REFERENCE_MIN_FREQUENCY = 2;
const SHARED_REFERENCE_FETCH_LIMIT = 20;
const OPENALEX_ID_CHUNK_SIZE = 20;
const GRAPH_BOOST_CAP = 0.05;
const MAX_PROJECT_IDEAS = 5;
const MAX_PROJECT_TITLE_WORDS = 14;
const MIN_FIRST_EXPERIMENT_WORDS = 10;
const ACTION_VERBS = ["generate", "compare", "build", "test", "measure", "simulate", "train", "benchmark", "optimize", "analyze"];
const GENERIC_PROJECT_BRIDGES = new Set(["analysis", "application", "approach", "design", "engineering", "method", "model", "modeling", "optimization", "performance", "study", "system"]);
const ACOUSTIC_EVIDENCE_TERMS = ["noise", "aeroacoustic", "aeroacoustics", "sound pressure", "spl", "acoustic", "sound level"];
const SENSOR_EVIDENCE_TERMS = ["sensor", "sensors", "measurement", "measurements", "monitoring", "bas", "bms", "building data"];
const SAFETY_EVIDENCE_TERMS = ["thermal runaway", "abuse", "safety", "failure risk", "hazard", "overcharge"];
const PHYSICAL_OUTCOME_EVIDENCE: Array<{ outcome: string; terms: string[] }> = [
  { outcome: "pressure drop reduction", terms: ["pressure drop", "pressure loss", "static pressure"] },
  { outcome: "airflow uniformity", terms: ["airflow uniformity", "airflow distribution", "air distribution", "occupied zone", "velocity field"] },
  { outcome: "thermal comfort", terms: ["thermal comfort", "comfort", "pmv", "ppd", "occupied zone"] },
  { outcome: "ventilation effectiveness", terms: ["ventilation effectiveness", "air change", "fresh air", "ventilation rate"] },
  { outcome: "energy use reduction", terms: ["energy use", "energy consumption", "fan power", "energy efficiency"] },
  { outcome: "occupied-zone velocity", terms: ["occupied-zone velocity", "occupied zone velocity", "airspeed", "air speed"] },
  { outcome: "heat generation", terms: ["heat generation", "heat rate", "heat flux"] },
  { outcome: "peak cell temperature", terms: ["peak cell temperature", "maximum temperature", "cell temperature"] },
  { outcome: "thermal runaway risk", terms: ["thermal runaway", "abuse", "safety"] },
  { outcome: "grip force", terms: ["grip force", "grasp force", "contact force"] },
  { outcome: "manipulation success", terms: ["manipulation success", "grasp success", "success rate"] },
  { outcome: "disturbance rejection", terms: ["disturbance rejection", "disturbance", "step disturbance"] },
  { outcome: "delamination growth", terms: ["delamination growth", "delamination", "crack growth"] },
  { outcome: "stiffness-to-weight", terms: ["stiffness-to-weight", "specific stiffness", "lightweight"] },
  { outcome: "surface roughness", terms: ["surface roughness", "roughness", "surface finish"] },
  { outcome: "defect rate", terms: ["defect rate", "defect", "porosity"] },
  { outcome: "print strength", terms: ["print strength", "tensile strength", "mechanical strength"] }
];

type BuildResearchMapDeps = {
  citationHistoryFetcher?: (workIds: string[]) => Promise<Map<string, CitationHistoryResult>>;
  referenceFetcher?: (workIds: string[]) => Promise<OpenAlexWork[]>;
  relevanceJudge?: JudgeFn;
  judgeCache?: JudgeCache;
  hardFilterJudge?: boolean;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "based",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "learning",
  "machine",
  "of",
  "on",
  "or",
  "research",
  "the",
  "to",
  "using",
  "with"
]);

function resolveBuildResearchMapDeps(
  deps: BuildResearchMapDeps | ((workIds: string[]) => Promise<Map<string, CitationHistoryResult>>),
  legacyReferenceFetcher: (workIds: string[]) => Promise<OpenAlexWork[]>
): Required<Pick<BuildResearchMapDeps, "citationHistoryFetcher" | "referenceFetcher">> &
  Pick<BuildResearchMapDeps, "relevanceJudge" | "judgeCache" | "hardFilterJudge"> {
  if (typeof deps === "function") {
    return {
      citationHistoryFetcher: deps,
      referenceFetcher: legacyReferenceFetcher,
      relevanceJudge: undefined,
      judgeCache: undefined,
      hardFilterJudge: false
    };
  }

  return {
    citationHistoryFetcher: deps.citationHistoryFetcher ?? fetchCitationHistoryForWorks,
    referenceFetcher: deps.referenceFetcher ?? fetchOpenAlexWorksByIds,
    relevanceJudge: deps.relevanceJudge,
    judgeCache: deps.judgeCache,
    hardFilterJudge: deps.hardFilterJudge ?? false
  };
}

export async function buildResearchMap(
  request: ResearchMapRequest,
  works: OpenAlexWork[],
  deps: BuildResearchMapDeps | ((workIds: string[]) => Promise<Map<string, CitationHistoryResult>>) = {},
  legacyReferenceFetcher = fetchOpenAlexWorksByIds
): Promise<ResearchMapResponse> {
  const resolvedDeps = resolveBuildResearchMapDeps(deps, legacyReferenceFetcher);
  const requestBudget = createRequestBudget();
  const normalizedRequest = normalizeRequest(request);
  const preGate = filterByRelevance(normalizedRequest.topic, works);
  const normalized = normalizeWorks(normalizedRequest, works);
  const pregatedWorks = applyPreGateSignals(normalized.works, preGate);
  const initiallyScored = scoreWorks(normalizedRequest, pregatedWorks);
  const semantic = await applySemanticRelevance(initiallyScored, buildQueryText(normalizedRequest.topic, normalizedRequest.field, normalizedRequest.goal));
  const firstPassScored = scoreWorks(normalizedRequest, semantic.works);
  const judged = await applyRelevanceJudge(normalizedRequest, firstPassScored, {
    judge: resolvedDeps.relevanceJudge,
    cache: resolvedDeps.judgeCache,
    enabled: Boolean(resolvedDeps.relevanceJudge) || undefined
  });
  const scored = scoreWorks(normalizedRequest, judged.works);
  const filterResult = applyJudgeHardFilter(scored, Boolean(resolvedDeps.hardFilterJudge));
  const usableWorks = filterResult.usableWorks;
  const clusters = buildClusters(usableWorks);
  const initialFoundationalWorks = usableWorks
    .slice()
    .sort((a, b) => (b.rankScore ?? b.foundationalScore) - (a.rankScore ?? a.foundationalScore))
    .slice(0, FOUNDATIONAL_LIMIT);
  const recentInfluenceWorks = usableWorks
    .slice()
    .sort((a, b) => b.recentInfluenceScore - a.recentInfluenceScore)
    .slice(0, WATCH_NOW_LIMIT);
  const relevanceSeedWorks = usableWorks
    .slice()
    .sort((a, b) => b.finalRelevanceScore - a.finalRelevanceScore)
    .slice(0, RELEVANCE_SEED_LIMIT);
  const citationNetworkSignals = await buildCitationNetworkSignals(
    normalizedRequest,
    dedupeWorks([...initialFoundationalWorks, ...recentInfluenceWorks, ...relevanceSeedWorks]),
    clusters,
    requestBudget,
    resolvedDeps.referenceFetcher
  );
  const graphSupported = applyGraphSupport(usableWorks, citationNetworkSignals);
  const foundationalPapers = graphSupported
    .slice()
    .sort((a, b) => (b.rankScore ?? b.foundationalScore) - (a.rankScore ?? a.foundationalScore))
    .slice(0, FOUNDATIONAL_LIMIT)
    .map((work) =>
      toPaperRecommendation(
        work,
        work.rankScore ?? work.foundationalScore,
        reasonCodesFromContributions(work.scoreContributions ?? foundationalContributions(work))
      )
    );
  const recentInfluencePapersWithoutHistory = graphSupported
    .slice()
    .sort((a, b) => b.recentInfluenceScore - a.recentInfluenceScore)
    .slice(0, WATCH_NOW_LIMIT)
    .map((work) =>
      toPaperRecommendation(work, work.recentInfluenceScore, reasonCodesFromContributions(recentInfluenceContributions(work)), "recent-influence")
    );
  const recentInfluencePapers = await enrichWithCitationHistory(recentInfluencePapersWithoutHistory, requestBudget, resolvedDeps.citationHistoryFetcher);
  const people = buildPeople(graphSupported, recentInfluencePapers.map((paper) => paper.id));
  const queryFocus = buildQueryFocus(normalizedRequest, graphSupported, clusters);
  const projectIdeas = buildProjectIdeas(normalizedRequest, clusters, graphSupported, citationNetworkSignals, queryFocus);
  const confidence = computeMapConfidence(graphSupported.length, median(graphSupported.map((work) => work.relevanceScore)));
  const dataQuality = buildDataQuality(works, graphSupported, normalized.dedupedCount, normalized.excludedRetractedCount);
  const judgeSignals = mergeJudgeSignals(judged.signals, filterResult.excludedPapers.length);
  const warnings = buildWarnings(dataQuality, confidence, semantic.signals.enabled, judgeSignals);
  if (recentInfluencePapers.length && recentInfluencePapers.every((paper) => paper.citationHistoryStatus === "unavailable")) {
    warnings.push("Citation history unavailable; using citations/year proxy for Watch Now.");
  }
  if (requestBudget.remaining() === 0) {
    warnings.push("OpenAlex request budget reached; optional citation-network or citation-history fallbacks may be incomplete.");
  }
  const evidence = buildEvidence(foundationalPapers, recentInfluencePapers, people, clusters);
  const citationSignals = buildCitationSignals(graphSupported, clusters, confidence);
  const researchDirectionSummary = buildResearchDirectionSummary(clusters);

  return {
    query: normalizedRequest,
    confidence,
    foundationalPapers,
    recentInfluencePapers,
    people,
    clusters: clusters.slice(0, CLUSTER_LIMIT),
    queryFocus,
    citationSignals,
    citationNetworkSignals: {
      ...citationNetworkSignals,
      requestBudgetUsed: requestBudget.used
    },
    researchDirectionSummary,
    semanticSignals: semantic.signals,
    judgeSignals,
    excludedPapers: filterResult.excludedPapers,
    projectIdeas,
    evidence,
    warnings,
    dataQuality,
    metricsVersion: "v1",
    generatedAt: new Date().toISOString()
  };
}

export function normalizeWorks(
  request: ResearchMapRequest,
  works: OpenAlexWork[]
): { works: NormalizedWork[]; dedupedCount: number; excludedRetractedCount: number } {
  const seen = new Set<string>();
  let dedupedCount = 0;
  let excludedRetractedCount = 0;
  const normalized: NormalizedWork[] = [];

  works.forEach((work, index) => {
    if (work.is_retracted) {
      excludedRetractedCount += 1;
      return;
    }

    const title = (work.display_name ?? "").trim();
    const year = work.publication_year ?? 0;
    if (!title || year < request.fromYear || year > request.toYear) {
      return;
    }

    const normalizedTitle = normalizeTitle(title);
    const abstractText = reconstructAbstract(work.abstract_inverted_index);
    const doi = normalizeDoi(work.doi);
    const dedupeKey = doi ? `doi:${doi}` : `title:${normalizedTitle}:${year}`;
    if (seen.has(work.id) || seen.has(dedupeKey)) {
      dedupedCount += 1;
      return;
    }
    seen.add(work.id);
    seen.add(dedupeKey);

    normalized.push({
      id: work.id,
      doi,
      title,
      normalizedTitle,
      year,
      publicationDate: work.publication_date ?? null,
      citationCount: work.cited_by_count ?? 0,
      citationPercentileValue: work.citation_normalized_percentile?.value ?? null,
      authors: normalizeAuthors(work.authorships),
      primaryTopic: work.primary_topic ?? null,
      topics: work.topics ?? [],
      keywords: (work.keywords ?? []).map((keyword) => keyword.display_name ?? "").filter(Boolean),
      abstractText,
      compactText: buildCompactText(title, abstractText, work.primary_topic, work.topics, work.keywords),
      type: work.type ?? null,
      isRetracted: Boolean(work.is_retracted),
      hasAbstract: Boolean(work.abstract_inverted_index),
      countsByYear: work.counts_by_year ?? [],
      referencedWorks: work.referenced_works ?? [],
      referencedWorksCount: work.referenced_works_count ?? null,
      fwci: work.fwci ?? null,
      citedByApiUrl: work.cited_by_api_url ?? null,
      url: work.id,
      relevanceScore: searchOrderRelevance(
        index,
        works.length,
        request.topic,
        request.field ?? "mechanical engineering",
        title,
        work.primary_topic,
        work.topics,
        work.keywords,
        work.relevance_score
      ),
      keywordRelevanceScore: searchOrderRelevance(
        index,
        works.length,
        request.topic,
        request.field ?? "mechanical engineering",
        title,
        work.primary_topic,
        work.topics,
        work.keywords,
        work.relevance_score
      ),
      semanticRelevanceScore: null,
      finalRelevanceScore: 0,
      embeddingModel: null,
      preGateScore: 1,
      preGateCosine: null,
      preGateCoverage: null,
      preGateDriftDomains: [],
      preGateReasonCodes: [],
      judged: false,
      judgeGrade: null,
      judgeGradeScore: null,
      judgeOnTopic: null,
      judgeAbout: null,
      judgeReason: null,
      logCitationScore: 0,
      citationPercentileScore: 0,
      citationsPerYearScore: 0,
      recencyScore: 0,
      sourceQualityScore: sourceQualityScore(work.type),
      graphSupportScore: 0,
      graphSupportSeedCount: 0,
      graphSupportSeedTotal: 0,
      foundationalScore: 0,
      recentInfluenceScore: 0,
      rankScore: 0,
      scoreContributions: [],
      citationsPerYear: 0
    });
  });

  return { works: normalized, dedupedCount, excludedRetractedCount };
}

function normalizeRequest(request: ResearchMapRequest): ResearchMapRequest {
  return {
    ...request,
    field: request.field?.trim() || "mechanical engineering"
  };
}

function applyPreGateSignals(works: NormalizedWork[], relevance: RelevanceSummary): NormalizedWork[] {
  const byId = new Map(relevance.results.map((result) => [result.work.id, result]));
  return works.map((work) => {
    const result = byId.get(work.id);
    if (!result) {
      return work;
    }
    return {
      ...work,
      preGateScore: result.effectiveScore,
      preGateCosine: result.cosine,
      preGateCoverage: result.coverage,
      preGateDriftDomains: result.driftDomains,
      preGateReasonCodes: result.reasons
    };
  });
}

function applyJudgeHardFilter(
  works: NormalizedWork[],
  hardFilterJudge: boolean
): { usableWorks: NormalizedWork[]; excludedPapers: ExcludedPaper[] } {
  if (!hardFilterJudge) {
    return { usableWorks: works, excludedPapers: [] };
  }

  const usableWorks: NormalizedWork[] = [];
  const excludedPapers: ExcludedPaper[] = [];
  for (const work of works) {
    if (work.judged && work.judgeGrade === 0) {
      excludedPapers.push({
        id: work.id,
        title: work.title,
        judgeGrade: work.judgeGrade,
        reason: work.judgeReason ?? "Judge marked this paper off-topic."
      });
    } else {
      usableWorks.push(work);
    }
  }
  return { usableWorks, excludedPapers };
}

function mergeJudgeSignals(signals: JudgeSignals, filteredOffTopicCount: number): JudgeSignals {
  return {
    ...signals,
    filteredOffTopicCount
  };
}

export function scoreWorks(request: ResearchMapRequest, works: NormalizedWork[]): NormalizedWork[] {
  const currentYear = new Date().getFullYear();
  const logCitations = works.map((work) => Math.log1p(work.citationCount));
  const citationsPerYear = works.map((work) => work.citationCount / Math.max(1, currentYear - work.year + 1));
  const localCitationPercentiles = percentileValues(works.map((work) => work.citationCount));

  return works.map((work, index) => {
    const ageWindow = Math.max(1, request.toYear - request.fromYear);
    const normalizedAge = Math.min(1, Math.max(0, (request.toYear - work.year) / ageWindow));
    const citationPercentileScore = clamp01(work.citationPercentileValue ?? localCitationPercentiles[index] ?? 0);
    const relevanceBeforePreGate = blendRelevance(work.keywordRelevanceScore || work.relevanceScore, work.semanticRelevanceScore, work.judgeGradeScore ?? null);
    const preGateDemotion = (work.preGateDriftDomains ?? []).length ? 0.85 : 1;
    const finalRelevanceScore = clamp01(relevanceBeforePreGate * preGateDemotion);
    const scored: NormalizedWork = {
      ...work,
      finalRelevanceScore,
      relevanceScore: finalRelevanceScore,
      logCitationScore: localPercentile(logCitations[index] ?? 0, logCitations),
      citationPercentileScore,
      citationsPerYearScore: localPercentile(citationsPerYear[index] ?? 0, citationsPerYear),
      recencyScore: 1 - normalizedAge,
      citationsPerYear: citationsPerYear[index] ?? 0
    };
    scored.foundationalScore =
      0.4 * scored.logCitationScore +
      0.3 * scored.citationPercentileScore +
      0.2 * scored.finalRelevanceScore +
      0.1 * scored.sourceQualityScore;
    scored.recentInfluenceScore =
      0.3 * scored.citationsPerYearScore +
      0.25 * scored.recencyScore +
      0.3 * scored.finalRelevanceScore +
      0.15 * scored.citationPercentileScore;
    scored.rankScore = scored.foundationalScore + scored.graphSupportScore;
    scored.scoreContributions = foundationalContributions(scored);
    return scored;
  });
}

function foundationalContributions(work: NormalizedWork): ScoreContribution[] {
  return [
    contribution("citation-mass", "Citation mass", 0.4 * work.logCitationScore),
    contribution("citation-percentile", "Citation percentile", 0.3 * work.citationPercentileScore),
    contribution("topic-aboutness", "Topic aboutness", 0.2 * work.finalRelevanceScore),
    contribution("source-quality", "Source quality", 0.1 * work.sourceQualityScore),
    contribution("graph-support", "Shared-reference graph support", work.graphSupportScore)
  ].filter((item) => item.value > 0);
}

function recentInfluenceContributions(work: NormalizedWork): ScoreContribution[] {
  return [
    contribution("citations-per-year", "Citations per year", 0.3 * work.citationsPerYearScore),
    contribution("recency", "Publication recency", 0.25 * work.recencyScore),
    contribution("topic-aboutness", "Topic aboutness", 0.3 * work.finalRelevanceScore),
    contribution("citation-percentile", "Citation percentile", 0.15 * work.citationPercentileScore)
  ].filter((item) => item.value > 0);
}

function contribution(code: string, label: string, value: number): ScoreContribution {
  return {
    code,
    label,
    value: Number(value.toFixed(6))
  };
}

function reasonCodesFromContributions(contributions: ScoreContribution[]): string[] {
  const codes = contributions
    .slice()
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => item.code);
  return codes.length ? codes : ["insufficient-score-signal"];
}

function appendDiagnosticReasonCodes(reasonCodes: string[], work: NormalizedWork): string[] {
  return uniqueTokens([
    ...reasonCodes,
    ...(work.preGateDriftDomains ?? []).length ? ["pre-gate-drift-demotion"] : [],
    ...(work.judged ? [`judge-grade-${work.judgeGrade}`] : []),
    !work.hasAbstract ? "unverified-no-abstract" : ""
  ]);
}

export function buildClusters(works: NormalizedWork[]): TopicCluster[] {
  const buckets = new Map<string, { label: string; works: NormalizedWork[] }>();

  for (const work of works) {
    const topic = bestClusterLabel(work);
    const existing = buckets.get(topic.id) ?? { label: topic.label, works: [] };
    existing.works.push(work);
    buckets.set(topic.id, existing);
  }

  const maxPaperCount = Math.max(1, ...Array.from(buckets.values()).map((bucket) => bucket.works.length));
  const currentYear = new Date().getFullYear();

  return Array.from(buckets.entries())
    .map(([id, bucket]) => {
      const recentWorks = bucket.works.filter((work) => currentYear - work.year <= 5);
      const normalizedPaperCount = bucket.works.length / maxPaperCount;
      const averageRecentInfluenceScore = average(bucket.works.map((work) => work.recentInfluenceScore));
      const recentPaperShare = recentWorks.length / bucket.works.length;
      const averageRelevanceScore = average(bucket.works.map((work) => work.relevanceScore));
      const score =
        0.35 * normalizedPaperCount +
        0.25 * averageRecentInfluenceScore +
        0.2 * recentPaperShare +
        0.2 * averageRelevanceScore;
      return {
        id,
        label: bucket.label,
        score,
        paperCount: bucket.works.length,
        recentPaperShare,
        averageRelevanceScore,
        averageRecentInfluenceScore,
        paperIds: bucket.works
          .slice()
          .sort((a, b) => b.recentInfluenceScore - a.recentInfluenceScore)
          .slice(0, 8)
          .map((work) => work.id)
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildPeople(works: NormalizedWork[], recentInfluencePaperIds: string[]): ResearcherRecommendation[] {
  const recentInfluenceSet = new Set(recentInfluencePaperIds);
  const authorWorks = new Map<string, { author: AuthorSummary; works: NormalizedWork[] }>();
  const currentYear = new Date().getFullYear();

  for (const work of works) {
    for (const author of work.authors) {
      const existing = authorWorks.get(author.id) ?? { author, works: [] };
      existing.works.push(work);
      authorWorks.set(author.id, existing);
    }
  }

  const maxRelevant = Math.max(1, ...Array.from(authorWorks.values()).map((entry) => entry.works.length));

  return Array.from(authorWorks.values())
    .map((entry) => {
      const recentPaperCount = entry.works.filter((work) => currentYear - work.year <= 5).length;
      const risingPaperInvolvementCount = entry.works.filter((work) => recentInfluenceSet.has(work.id)).length;
      const relevantPaperCountScore = entry.works.length / maxRelevant;
      const recentPaperCountScore = recentPaperCount / Math.max(1, entry.works.length);
      const risingPaperInvolvementScore = Math.min(1, risingPaperInvolvementCount / 3);
      const averagePaperRelevanceScore = average(entry.works.map((work) => work.relevanceScore));
      const score =
        0.35 * relevantPaperCountScore +
        0.25 * recentPaperCountScore +
        0.25 * risingPaperInvolvementScore +
        0.15 * averagePaperRelevanceScore;
      return {
        id: entry.author.id,
        name: entry.author.name,
        score,
        relevantPaperCount: entry.works.length,
        recentPaperCount,
        risingPaperInvolvementCount,
        paperIds: entry.works
          .slice()
          .sort((a, b) => b.recentInfluenceScore - a.recentInfluenceScore)
          .slice(0, 6)
          .map((work) => work.id)
      };
    })
    .filter((person) => person.relevantPaperCount > 1 || person.risingPaperInvolvementCount > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, PEOPLE_LIMIT);
}

export function buildProjectIdeas(
  request: ResearchMapRequest,
  clusters: TopicCluster[],
  works: NormalizedWork[],
  citationNetworkSignals: CitationNetworkSignals,
  queryFocus: QueryFocus
): ProjectIdea[] {
  const clusterCandidates = clusters.slice(0, 8).flatMap((cluster) => {
    const supportingWorks = supportingWorksForCluster(cluster, works);
    const ingredients = extractProjectIngredients(cluster, supportingWorks, request);
    return generateProjectCandidates({
      request,
      clusters: [cluster],
      supportingWorks,
      ingredients,
      citationNetworkSignals,
      queryFocus,
      bridgeSignal: null
    });
  });

  const crossClusterCandidates = generateCrossClusterProjectCandidates(request, clusters, works, citationNetworkSignals, queryFocus);
  const filtered = filterProjectCandidates([...clusterCandidates, ...crossClusterCandidates]);
  const scored = scoreProjectCandidates(filtered, works);

  return dedupeAndTakeTopProjectIdeas(scored, MAX_PROJECT_IDEAS);
}

type ProjectIngredients = NonNullable<ProjectIdea["projectIngredients"]>;

type ProjectVocabularyCategory = keyof ProjectIngredients;

type ProjectVocabularyEntry = {
  label: string;
  terms: string[];
};

type ProjectCandidate = {
  title: string;
  description: string;
  firstExperiment: string;
  projectType: NonNullable<ProjectIdea["projectType"]>;
  ingredients: ProjectIngredients;
  clusters: TopicCluster[];
  supportingWorks: NormalizedWork[];
  supportingReferenceIds: string[];
  evidenceTypes: EvidenceType[];
  bridgeSignal: string | null;
  queryFocus: QueryFocus;
  difficulty: ProjectIdea["difficulty"];
  order: number;
};

type ScoredProjectCandidate = ProjectCandidate & {
  score: number;
  distinctivenessScore: number;
  specificityScore: number;
  evidenceScore: number;
  executionFitScore: number;
  traceabilityScore: number;
  confidence: Confidence;
  distinctivenessSignals: string[];
};

const PROJECT_VOCABULARY: Record<ProjectVocabularyCategory, ProjectVocabularyEntry[]> = {
  methods: [
    entry("surrogate modeling", ["surrogate model", "surrogate modeling", "reduced order", "reduced-order", "machine learning", "neural network", "physics informed", "physics-informed"]),
    entry("CFD validation", ["cfd", "computational fluid dynamics", "flow simulation", "fluid simulation"]),
    entry("thermal modeling", ["thermal model", "thermal modeling", "heat transfer", "temperature model"]),
    entry("PID control", ["pid", "control", "controller", "tracking control"]),
    entry("fatigue testing", ["fatigue test", "fatigue testing", "fatigue life", "crack initiation"]),
    entry("topology optimization", ["topology optimization", "shape optimization", "geometry optimization"]),
    entry("benchmarking", ["benchmark", "benchmarking", "comparison", "comparative"]),
    entry("experimental validation", ["experimental validation", "experiment", "testing", "validated", "validation"])
  ],
  systems: [
    entry("HVAC diffuser", ["hvac diffuser", "diffuser", "hvac", "ventilation", "indoor airflow"]),
    entry("battery pack", ["battery pack", "battery packs", "lithium ion", "lithium-ion", "battery cell", "battery cells"]),
    entry("cooling plate", ["cooling plate", "cold plate", "liquid cooling", "cooling channel"]),
    entry("robotic gripper", ["robotic gripper", "soft gripper", "gripper", "manipulator"]),
    entry("composite laminate", ["composite laminate", "composite material", "fiber reinforced", "delamination"]),
    entry("heat exchanger", ["heat exchanger", "thermal exchanger"]),
    entry("motor drive", ["motor drive", "electric motor", "motor control"]),
    entry("pump", ["pump", "impeller", "centrifugal pump"]),
    entry("bearing", ["bearing", "rolling bearing", "journal bearing"]),
    entry("gear train", ["gear", "gear train", "gearbox"]),
    entry("acoustic enclosure", ["acoustic enclosure", "noise enclosure", "sound enclosure"])
  ],
  applications: [
    entry("fast design iteration", ["design iteration", "rapid design", "fast design", "optimization workflow"]),
    entry("indoor thermal comfort", ["thermal comfort", "indoor comfort", "occupied zone"]),
    entry("fast charging", ["fast charging", "charging", "charge rate"]),
    entry("delicate manipulation", ["delicate object", "manipulation", "grasping"]),
    entry("additive manufacturing inspection", ["additive manufacturing", "3d print", "powder bed", "defect detection"])
  ],
  outcomes: [
    entry("pressure drop reduction", ["pressure drop", "pressure loss"]),
    entry("airflow uniformity", ["airflow uniformity", "airflow distribution", "air distribution", "velocity field"]),
    entry("thermal comfort", ["thermal comfort", "occupied zone", "pmv", "ppd"]),
    entry("ventilation effectiveness", ["ventilation effectiveness", "air change", "ventilation rate"]),
    entry("temperature uniformity", ["temperature uniformity", "thermal uniformity", "temperature distribution"]),
    entry("heat generation", ["heat generation", "heat rate", "heat flux"]),
    entry("peak cell temperature", ["peak cell temperature", "cell temperature", "maximum temperature"]),
    entry("thermal runaway risk", ["thermal runaway", "abuse", "battery safety"]),
    entry("grip force", ["grip force", "grasp force", "contact force"]),
    entry("manipulation success", ["manipulation success", "grasp success", "success rate"]),
    entry("fatigue life prediction", ["fatigue life", "life prediction", "crack initiation"]),
    entry("delamination growth", ["delamination growth", "delamination", "crack growth"]),
    entry("stiffness-to-weight", ["stiffness-to-weight", "specific stiffness", "lightweight"]),
    entry("tracking error reduction", ["tracking error", "trajectory tracking", "position error"]),
    entry("disturbance rejection", ["disturbance rejection", "disturbance"]),
    entry("efficiency improvement", ["efficiency", "energy efficiency", "performance improvement"]),
    entry("vibration reduction", ["vibration", "vibration reduction", "modal"]),
    entry("noise reduction", ["noise", "acoustic", "sound pressure"]),
    entry("surface roughness", ["surface roughness", "roughness", "surface finish"]),
    entry("defect rate", ["defect rate", "defect", "porosity"]),
    entry("print strength", ["print strength", "tensile strength", "mechanical strength"]),
    entry("prediction accuracy", ["prediction accuracy", "rmse", "error prediction"])
  ],
  materialsOrDatasets: [
    entry("lithium-ion cells", ["lithium ion", "lithium-ion", "battery cell", "battery cells"]),
    entry("composite materials", ["composite", "fiber reinforced", "laminate"]),
    entry("additive manufacturing data", ["additive manufacturing", "3d printing", "powder bed"]),
    entry("sensor logs", ["sensor", "sensor logs", "measurement data"]),
    entry("CFD dataset", ["cfd case", "cfd cases", "simulation case", "flow simulation", "cfd dataset"]),
    entry("fatigue test data", ["fatigue test", "fatigue data", "s-n curve"])
  ],
  limitationSignals: [
    entry("limited validation", ["limited validation", "lack of validation", "validation remains", "not validated"]),
    entry("sparse benchmarking", ["sparse benchmark", "few benchmark", "limited benchmark", "comparison is limited"]),
    entry("weak recent-paper signal", ["low recent", "few recent", "older literature"]),
    entry("fragmented clusters", ["fragmented", "multiple clusters", "different subfields"]),
    entry("few comparative studies", ["few comparative", "limited comparison", "comparative study"])
  ]
};

function entry(label: string, terms: string[]): ProjectVocabularyEntry {
  return { label, terms };
}

function supportingWorksForCluster(cluster: TopicCluster, works: NormalizedWork[]): NormalizedWork[] {
  return cluster.paperIds
    .map((paperId) => works.find((work) => work.id === paperId))
    .filter((work): work is NormalizedWork => Boolean(work))
    .slice(0, 6);
}

function extractProjectIngredients(cluster: TopicCluster, supportingWorks: NormalizedWork[], request: ResearchMapRequest): ProjectIngredients {
  const text = [request.topic, request.field ?? "", cluster.label, ...supportingWorks.map((work) => work.compactText)].join(" ");
  const ingredients: ProjectIngredients = {
    methods: extractVocabularyLabels(text, "methods"),
    systems: extractVocabularyLabels(text, "systems"),
    applications: extractVocabularyLabels(text, "applications"),
    outcomes: extractVocabularyLabels(text, "outcomes"),
    materialsOrDatasets: extractVocabularyLabels(text, "materialsOrDatasets"),
    limitationSignals: extractVocabularyLabels(text, "limitationSignals")
  };
  ingredients.outcomes = normalizeOutcomesForProjectTitles(ingredients.outcomes, text);

  if (!ingredients.methods.length) {
    ingredients.methods = ["benchmarking"];
  }
  if (!ingredients.systems.length && cluster.label) {
    ingredients.systems = [readableClusterSystem(cluster.label)];
  }
  ingredients.outcomes = constrainOutcomesForSystem(ingredients.outcomes, ingredients.systems[0] ?? ingredients.applications[0] ?? "");
  if (!ingredients.outcomes.length) {
    ingredients.outcomes = [supportedPhysicalOutcome(text) ?? "model benchmark error"];
  }
  ingredients.outcomes = constrainOutcomesForSystem(ingredients.outcomes, ingredients.systems[0] ?? ingredients.applications[0] ?? "");
  if (!ingredients.outcomes.length) {
    ingredients.outcomes = defaultOutcomesForSystem(systemFamily(ingredients.systems[0] ?? ingredients.applications[0] ?? ""), text, []).slice(0, 1);
  }
  if (!ingredients.materialsOrDatasets.length && (ingredients.methods.includes("CFD validation") || textMentions(text, ["cfd", "computational fluid dynamics", "flow simulation"]))) {
    ingredients.materialsOrDatasets = ["CFD dataset"];
  }
  if (ingredients.materialsOrDatasets.includes("sensor logs") && !hasSensorEvidence(text)) {
    ingredients.materialsOrDatasets = ingredients.materialsOrDatasets.filter((item) => item !== "sensor logs");
  }
  if (!ingredients.materialsOrDatasets.length && ingredients.methods.includes("surrogate modeling")) {
    ingredients.materialsOrDatasets = textMentions(text, ["cfd", "diffuser", "airflow", "flow simulation"]) ? ["CFD dataset"] : ["simulation dataset"];
  }
  if (!ingredients.limitationSignals.length && cluster.paperCount <= 2) {
    ingredients.limitationSignals = ["weak recent-paper signal"];
  }

  return ingredients;
}

function extractVocabularyLabels(text: string, category: ProjectVocabularyCategory): string[] {
  const normalized = normalizeTitle(text);
  return PROJECT_VOCABULARY[category]
    .filter((item) => item.terms.some((term) => normalized.includes(normalizeTitle(term))))
    .map((item) => item.label)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 4);
}

function normalizeOutcomesForProjectTitles(outcomes: string[], evidenceText: string): string[] {
  const normalized: string[] = [];
  for (const outcome of outcomes) {
    const titleOutcome = normalizeOutcomeForProjectTitle(outcome, evidenceText);
    if (titleOutcome && !normalized.includes(titleOutcome)) {
      normalized.push(titleOutcome);
    }
  }
  return normalized;
}

function normalizeOutcomeForProjectTitle(outcome: string, evidenceText: string): string | null {
  const family = outcomeFamily(outcome);
  if (family === "model-metric") {
    return null;
  }
  if (family === "noise" && !hasAcousticEvidence(evidenceText)) {
    return null;
  }
  if (family === "vague-efficiency") {
    return supportedPhysicalOutcome(evidenceText);
  }
  return hasPhysicalOutcomeEvidence(outcome, evidenceText) ? outcome : outcome;
}

function supportedPhysicalOutcome(evidenceText: string): string | null {
  return PHYSICAL_OUTCOME_EVIDENCE.find((item) => hasPhysicalOutcomeEvidence(item.outcome, evidenceText))?.outcome ?? null;
}

function hasPhysicalOutcomeEvidence(outcome: string, evidenceText: string): boolean {
  const family = outcomeFamily(outcome);
  const evidence = PHYSICAL_OUTCOME_EVIDENCE.find((item) => item.outcome === outcome);
  if (evidence) {
    return textMentions(evidenceText, evidence.terms);
  }
  if (family === "noise") {
    return hasAcousticEvidence(evidenceText);
  }
  if (family === "safety" || family === "failure-growth") {
    return requiresSpecialSafetyEvidence(family, evidenceText);
  }
  if (family === "model-metric" || family === "vague-efficiency") {
    return false;
  }
  return true;
}

function hasAcousticEvidence(text: string): boolean {
  return textMentions(text, ACOUSTIC_EVIDENCE_TERMS);
}

function hasSensorEvidence(text: string): boolean {
  return textMentions(text, SENSOR_EVIDENCE_TERMS);
}

function requiresSpecialSafetyEvidence(outcomeFamilyName: string, evidenceText: string): boolean {
  if (outcomeFamilyName === "safety") {
    return textMentions(evidenceText, SAFETY_EVIDENCE_TERMS);
  }
  if (outcomeFamilyName === "failure-growth") {
    return textMentions(evidenceText, ["delamination", "crack growth", "fracture", "failure", "damage growth"]);
  }
  return false;
}

function textMentions(text: string, terms: string[]): boolean {
  const normalized = normalizeTitle(text);
  return terms.some((term) => normalized.includes(normalizeTitle(term)));
}

function outcomeFamily(outcome: string): string {
  const normalized = normalizeTitle(outcome);
  if (normalized.includes("prediction accuracy") || normalized.includes("rmse") || normalized.includes("model benchmark")) return "model-metric";
  if (normalized.includes("efficiency")) return "vague-efficiency";
  if (normalized.includes("noise") || normalized.includes("acoustic") || normalized.includes("sound")) return "noise";
  if (normalized.includes("thermal runaway") || normalized.includes("safety") || normalized.includes("risk")) return "safety";
  if (normalized.includes("delamination") || normalized.includes("crack growth")) return "failure-growth";
  if (normalized.includes("stiffness")) return "structural";
  if (normalized.includes("grip") || normalized.includes("manipulation")) return "manipulation";
  if (normalized.includes("disturbance") || normalized.includes("tracking") || normalized.includes("position error")) return "control-disturbance";
  if (normalized.includes("pressure")) return "pressure";
  if (normalized.includes("airflow") || normalized.includes("velocity") || normalized.includes("ventilation")) return "airflow";
  if (normalized.includes("thermal") || normalized.includes("temperature") || normalized.includes("comfort") || normalized.includes("heat generation") || normalized.includes("peak cell")) return "thermal";
  if (normalized.includes("fatigue")) return "fatigue";
  if (normalized.includes("surface") || normalized.includes("defect") || normalized.includes("print strength")) return "manufacturing-quality";
  return normalized;
}

function methodFamily(method: string): string {
  const normalized = normalizeTitle(method);
  if (normalized.includes("surrogate") || normalized.includes("machine learning") || normalized.includes("neural")) return "surrogate-modeling";
  if (normalized.includes("cfd")) return "cfd";
  if (normalized.includes("thermal")) return "thermal-modeling";
  if (normalized.includes("pid") || normalized.includes("control")) return "pid-control";
  if (normalized.includes("topology")) return "topology-optimization";
  if (normalized.includes("experimental") || normalized.includes("validation")) return "experimental-validation";
  if (normalized.includes("benchmark")) return "benchmarking";
  if (normalized.includes("fatigue")) return "fatigue-testing";
  return normalized;
}

function systemFamily(system: string): string {
  const normalized = normalizeTitle(system);
  if (normalized.includes("hvac") || normalized.includes("diffuser") || normalized.includes("ventilation")) return "hvac-diffuser";
  if (normalized.includes("battery") || normalized.includes("cell")) return "battery-pack";
  if (normalized.includes("cooling plate") || normalized.includes("cold plate")) return "cooling-plate";
  if (normalized.includes("gripper") || normalized.includes("robot")) return "robotic-gripper";
  if (normalized.includes("composite") || normalized.includes("laminate")) return "composite-laminate";
  if (normalized.includes("motor") || normalized.includes("drive")) return "motor-drive";
  if (normalized.includes("heat exchanger")) return "heat-exchanger";
  if (normalized.includes("pump") || normalized.includes("impeller")) return "pump";
  if (normalized.includes("bearing")) return "bearing";
  if (normalized.includes("gear")) return "gear-train";
  if (normalized.includes("additive") || normalized.includes("manufacturing") || normalized.includes("print")) return "additive-manufacturing";
  if (normalized.includes("engineering system")) return "generic-engineering-system";
  return normalized;
}

function constrainOutcomesForSystem(outcomes: string[], system: string): string[] {
  const systemName = systemFamily(system);
  const allowedFamilies: Record<string, string[]> = {
    "hvac-diffuser": ["pressure", "airflow", "thermal", "model-metric", "vague-efficiency", "noise"],
    "battery-pack": ["thermal", "safety", "model-metric", "vague-efficiency"],
    "cooling-plate": ["thermal", "safety", "model-metric", "vague-efficiency"],
    "robotic-gripper": ["manipulation", "control-disturbance", "model-metric"],
    "composite-laminate": ["fatigue", "failure-growth", "structural", "model-metric"],
    "motor-drive": ["control-disturbance", "vague-efficiency", "model-metric"],
    "heat-exchanger": ["pressure", "thermal", "airflow", "vague-efficiency", "model-metric"],
    pump: ["pressure", "airflow", "vague-efficiency", "model-metric"],
    "additive-manufacturing": ["manufacturing-quality", "model-metric"]
  };
  const allowed = allowedFamilies[systemName];
  if (!allowed) return outcomes;
  return outcomes.filter((outcome) => allowed.includes(outcomeFamily(outcome)));
}

function readableClusterSystem(label: string): string {
  const normalized = normalizeTitle(label);
  if (!normalized || GENERIC_PROJECT_BRIDGES.has(normalized)) {
    return "engineering system";
  }
  return normalized.split(" ").slice(0, 4).join(" ");
}

function generateProjectCandidates(input: {
  request: ResearchMapRequest;
  clusters: TopicCluster[];
  supportingWorks: NormalizedWork[];
  ingredients: ProjectIngredients;
  citationNetworkSignals: CitationNetworkSignals;
  queryFocus: QueryFocus;
  bridgeSignal: string | null;
}): ProjectCandidate[] {
  const { request, clusters, supportingWorks, ingredients, citationNetworkSignals, bridgeSignal } = input;
  if (!supportingWorks.length) {
    return [];
  }

  const method = ingredients.methods[0] ?? "";
  const system = ingredients.systems[0] ?? ingredients.applications[0] ?? "";
  const outcome = ingredients.outcomes[0] ?? "";
  const materialOrDataset = ingredients.materialsOrDatasets[0] ?? datasetForMethod(method);
  const clusterLabel = clusters.map((cluster) => cluster.label).join(" + ");
  const supportingReferenceIds = citationNetworkSignals.topSharedReferences
    .filter((reference) => reference.relevanceGatePassed)
    .slice(0, 3)
    .map((reference) => reference.id);
  const evidenceTypes = projectEvidenceTypes(supportingWorks, supportingReferenceIds);
  const difficulty = request.experienceLevel === "beginner" ? "beginner" : request.experienceLevel === "technical" ? "advanced" : "intermediate";

  const baseTitle = titleCase([method, "for", system, outcome].filter(Boolean).join(" "));
  const projectType = projectTypeFor(method, system, materialOrDataset);
  const firstExperiment = buildFirstExperiment(method, system, materialOrDataset, outcome);
  const primary = candidateFromParts({
    title: baseTitle,
    description: `Compare ${method} choices for ${system} with ${outcome} as the main measurable target.`,
    firstExperiment,
    projectType,
    ingredients,
    clusters,
    supportingWorks,
    supportingReferenceIds,
    evidenceTypes,
    bridgeSignal,
    queryFocus: input.queryFocus,
    difficulty,
    order: 0
  });

  const benchmarkTitle = titleCase(["Benchmark", system, outcome, "with", materialOrDataset].filter(Boolean).join(" "));
  const benchmark = candidateFromParts({
    title: benchmarkTitle,
    description: `Build a compact benchmark around ${system} and report ${outcome} against one evidence-backed baseline.`,
    firstExperiment: buildBenchmarkExperiment(system, materialOrDataset, outcome),
    projectType: "benchmark",
    ingredients: { ...ingredients, methods: uniqueTokens([...ingredients.methods, "benchmarking"]) },
    clusters,
    supportingWorks,
    supportingReferenceIds,
    evidenceTypes,
    bridgeSignal,
    queryFocus: input.queryFocus,
    difficulty,
    order: 1
  });

  const validationTitle = validationProjectTitle(method, system, outcome);
  const validation = candidateFromParts({
    title: validationTitle,
    description: `Use ${clusterLabel.toLowerCase()} papers to validate whether ${method} transfers to a constrained ${system} case.`,
    firstExperiment: buildValidationExperiment(method, system, materialOrDataset, outcome),
    projectType: method.includes("testing") ? "experimental-test" : "replication",
    ingredients,
    clusters,
    supportingWorks,
    supportingReferenceIds,
    evidenceTypes,
    bridgeSignal,
    queryFocus: input.queryFocus,
    difficulty,
    order: 2
  });

  return [primary, benchmark, validation];
}

function candidateFromParts(candidate: ProjectCandidate): ProjectCandidate {
  return {
    ...candidate,
    title: trimProjectTitle(candidate.title),
    firstExperiment: candidate.firstExperiment.trim()
  };
}

function validationProjectTitle(method: string, system: string, outcome: string): string {
  if (methodFamily(method) === "experimental-validation") {
    return titleCase(["Validate", system, outcome, "baseline"].filter(Boolean).join(" "));
  }
  if (method.toLowerCase().includes("validation")) {
    return titleCase(["Replicate", system, outcome, "baseline"].filter(Boolean).join(" "));
  }
  return titleCase(["Validate", method, "for", system].filter(Boolean).join(" "));
}

function generateCrossClusterProjectCandidates(
  request: ResearchMapRequest,
  clusters: TopicCluster[],
  works: NormalizedWork[],
  citationNetworkSignals: CitationNetworkSignals,
  queryFocus: QueryFocus
): ProjectCandidate[] {
  const clusterEntries = clusters.slice(0, 5).map((cluster) => {
    const supportingWorks = supportingWorksForCluster(cluster, works);
    return {
      cluster,
      supportingWorks,
      ingredients: extractProjectIngredients(cluster, supportingWorks, request)
    };
  });
  const candidates: ProjectCandidate[] = [];

  for (let index = 0; index < clusterEntries.length - 1; index += 1) {
    const left = clusterEntries[index];
    const right = clusterEntries[index + 1];
    const bridge = crossClusterBridge(left.ingredients, right.ingredients, citationNetworkSignals);
    if (!bridge || !left.supportingWorks.length || !right.supportingWorks.length) {
      continue;
    }
    const ingredients = mergeProjectIngredients(left.ingredients, right.ingredients);
    candidates.push(
      ...generateProjectCandidates({
        request,
        clusters: [left.cluster, right.cluster],
        supportingWorks: [...left.supportingWorks.slice(0, 3), ...right.supportingWorks.slice(0, 3)],
        ingredients,
        citationNetworkSignals,
        queryFocus,
        bridgeSignal: bridge
      }).map((candidate) => ({ ...candidate, order: candidate.order + 20 + index * 3 }))
    );
  }

  return candidates;
}

function crossClusterBridge(
  left: ProjectIngredients,
  right: ProjectIngredients,
  citationNetworkSignals: CitationNetworkSignals
): string | null {
  const groups: Array<keyof ProjectIngredients> = ["methods", "systems", "applications", "outcomes", "materialsOrDatasets"];
  for (const group of groups) {
    const shared = left[group].find((item) => right[group].includes(item) && !GENERIC_PROJECT_BRIDGES.has(normalizeTitle(item)));
    if (shared) {
      return `shared ${groupLabel(group)}: ${shared}`;
    }
  }
  const reference = citationNetworkSignals.topSharedReferences.find((item) => item.relevanceGatePassed && item.referenceFrequency >= 2);
  return reference ? "shared-reference support" : null;
}

function groupLabel(group: keyof ProjectIngredients): string {
  if (group === "materialsOrDatasets") return "material/data source";
  if (group === "systems") return "system";
  if (group === "applications") return "application";
  if (group === "outcomes") return "outcome";
  return "method";
}

function mergeProjectIngredients(left: ProjectIngredients, right: ProjectIngredients): ProjectIngredients {
  return {
    methods: uniqueTokens([...left.methods, ...right.methods]).slice(0, 4),
    systems: uniqueTokens([...left.systems, ...right.systems]).slice(0, 4),
    applications: uniqueTokens([...left.applications, ...right.applications]).slice(0, 4),
    outcomes: uniqueTokens([...left.outcomes, ...right.outcomes]).slice(0, 4),
    materialsOrDatasets: uniqueTokens([...left.materialsOrDatasets, ...right.materialsOrDatasets]).slice(0, 4),
    limitationSignals: uniqueTokens([...left.limitationSignals, ...right.limitationSignals]).slice(0, 4)
  };
}

function filterProjectCandidates(candidates: ProjectCandidate[]): ProjectCandidate[] {
  const seenTitles = new Set<string>();

  return candidates.filter((candidate) => {
    const normalizedTitle = normalizeTitle(candidate.title);
    if (!candidate.supportingWorks.length || !hasMinimumProjectShape(candidate.ingredients)) return false;
    if (!candidate.firstExperiment || !isValidFirstExperiment(candidate.firstExperiment, candidate.ingredients)) return false;
    if (!normalizedTitle || normalizedTitle.includes("research map")) return false;
    if (isClusterLabelParaphrase(candidate.title, candidate.clusters)) return false;
    if (wordCount(candidate.title) > MAX_PROJECT_TITLE_WORDS) return false;
    if (seenTitles.has(normalizedTitle)) return false;
    seenTitles.add(normalizedTitle);
    return true;
  });
}

export function hasMinimumProjectShape(ingredients: ProjectIngredients): boolean {
  return countTrue([
    ingredients.methods.length > 0,
    ingredients.systems.length > 0 || ingredients.applications.length > 0,
    ingredients.outcomes.length > 0
  ]) >= 2;
}

export function isValidFirstExperiment(firstExperiment: string, ingredients: ProjectIngredients): boolean {
  const normalized = normalizeTitle(firstExperiment);
  if (wordCount(firstExperiment) < MIN_FIRST_EXPERIMENT_WORDS) return false;
  if (!ACTION_VERBS.some((verb) => normalized.includes(verb))) return false;
  const ingredientTerms = [
    ...ingredients.methods,
    ...ingredients.systems,
    ...ingredients.applications,
    ...ingredients.outcomes,
    ...ingredients.materialsOrDatasets
  ].flatMap((item) => tokenize(item));
  const experimentTokens = new Set(tokenize(firstExperiment));
  return ingredientTerms.some((term) => experimentTokens.has(term));
}

function scoreProjectCandidates(candidates: ProjectCandidate[], allWorks: NormalizedWork[]): ScoredProjectCandidate[] {
  return candidates.map((candidate) => {
    const specificityScore = computeProjectSpecificityScore(candidate.ingredients);
    const evidenceScore = computeEvidenceScore(candidate.supportingWorks, candidate.supportingReferenceIds);
    const executionFitScore = computeExecutionFitScore(candidate);
    const distinctivenessScore = computeDistinctivenessScore(candidate, allWorks);
    const traceabilityScore = computeTraceabilityScore(candidate);
    const score =
      0.3 * evidenceScore +
      0.25 * specificityScore +
      0.2 * executionFitScore +
      0.15 * distinctivenessScore +
      0.1 * traceabilityScore;

    return {
      ...candidate,
      score,
      specificityScore,
      evidenceScore,
      executionFitScore,
      distinctivenessScore,
      traceabilityScore,
      confidence: projectConfidence(candidate, evidenceScore),
      distinctivenessSignals: buildDistinctivenessSignals(candidate, distinctivenessScore)
    };
  });
}

function dedupeAndTakeTopProjectIdeas(candidates: ScoredProjectCandidate[], count: number): ProjectIdea[] {
  const grouped = new Map<string, ScoredProjectCandidate[]>();
  for (const candidate of candidates) {
    const key = projectConceptKey(candidate);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const conceptWinners = Array.from(grouped.values()).map((group) => mergeOutcomeSwapVariants(group));

  const seenTitles = new Set<string>();
  return conceptWinners
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.evidenceScore !== a.evidenceScore) return b.evidenceScore - a.evidenceScore;
      if (b.specificityScore !== a.specificityScore) return b.specificityScore - a.specificityScore;
      return a.order - b.order;
    })
    .filter((candidate) => {
      const titleKey = normalizeTitle(candidate.title);
      if (seenTitles.has(titleKey)) return false;
      seenTitles.add(titleKey);
      return true;
    })
    .slice(0, count)
    .map(projectIdeaFromCandidate);
}

function mergeOutcomeSwapVariants(group: ScoredProjectCandidate[]): ScoredProjectCandidate {
  const sorted = group.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.supportingWorks.length !== a.supportingWorks.length) return b.supportingWorks.length - a.supportingWorks.length;
    return a.order - b.order;
  });
  const best = sorted[0];

  if (group.length <= 1 || !areOutcomesMergeable(group)) {
    return best;
  }

  const supportingWorks = uniqueWorks(group.flatMap((candidate) => candidate.supportingWorks));
  const clusters = uniqueClusters(group.flatMap((candidate) => candidate.clusters));
  const supportingReferenceIds = uniqueTokens(group.flatMap((candidate) => candidate.supportingReferenceIds));
  const ingredients = mergeManyProjectIngredients(group.map((candidate) => candidate.ingredients));
  const mergedOutcomes = defaultOutcomesForSystem(systemFamily(best.ingredients.systems[0] ?? best.ingredients.applications[0] ?? ""), groupEvidenceText(group), ingredients.outcomes);
  const mergedDataSource = mergedDataSourceForConcept(best, ingredients);
  const mergedMethod = ingredients.methods[0] ?? best.ingredients.methods[0] ?? "modeling";
  const mergedSystem = ingredients.systems[0] ?? best.ingredients.systems[0] ?? best.ingredients.applications[0] ?? "engineering system";
  const merged: ScoredProjectCandidate = {
    ...best,
    title: mergedConceptTitle(mergedMethod, mergedSystem),
    description: `Build one ${mergedMethod} project around ${mergedSystem} and evaluate multiple compatible performance outputs instead of separate metric-swap variants.`,
    firstExperiment: mergedConceptExperiment(mergedMethod, mergedSystem, mergedOutcomes, mergedDataSource),
    projectType: best.projectType,
    ingredients: {
      ...ingredients,
      methods: uniqueTokens([mergedMethod, ...ingredients.methods]),
      systems: uniqueTokens([mergedSystem, ...ingredients.systems]),
      outcomes: mergedOutcomes,
      materialsOrDatasets: uniqueTokens([mergedDataSource, ...ingredients.materialsOrDatasets.filter((item) => item !== "sensor logs" || hasSensorEvidence(groupEvidenceText(group)))])
    },
    clusters,
    supportingWorks,
    supportingReferenceIds,
    evidenceTypes: uniqueTokens(group.flatMap((candidate) => candidate.evidenceTypes)) as EvidenceType[],
    bridgeSignal: group.find((candidate) => candidate.bridgeSignal)?.bridgeSignal ?? best.bridgeSignal,
    score: Math.max(...group.map((candidate) => candidate.score)) + 0.02,
    evidenceScore: computeEvidenceScore(supportingWorks, supportingReferenceIds),
    specificityScore: 1,
    executionFitScore: 1,
    distinctivenessScore: Math.max(...group.map((candidate) => candidate.distinctivenessScore)),
    traceabilityScore: Math.max(...group.map((candidate) => candidate.traceabilityScore)),
    confidence: projectConfidence({ ...best, supportingWorks, supportingReferenceIds, clusters }, computeEvidenceScore(supportingWorks, supportingReferenceIds)),
    distinctivenessSignals: uniqueTokens(["multi-objective physical outcomes", ...group.flatMap((candidate) => candidate.distinctivenessSignals)]).filter((signal) => !/novel|original/i.test(signal))
  };
  return merged;
}

function areOutcomesMergeable(group: ScoredProjectCandidate[]): boolean {
  const best = group[0];
  const key = projectConceptKey(best);
  const [methodName, systemName] = key.split("|");
  if (!methodName || !systemName || systemName === "generic-engineering-system") {
    return false;
  }
  const evidenceText = groupEvidenceText(group);
  const outcomeFamilies = uniqueTokens(group.flatMap((candidate) => candidate.ingredients.outcomes.map(outcomeFamily)));
  const physicalFamilies = outcomeFamilies.filter((family) => !["model-metric", "vague-efficiency"].includes(family));
  if (physicalFamilies.length < 2) {
    return group.length > 1 && outcomesShareExperimentPath(systemName, methodName, physicalFamilies, evidenceText);
  }
  return (
    outcomesShareExperimentPath(systemName, methodName, physicalFamilies, evidenceText) &&
    !requiresDistinctPhysics(systemName, methodName, physicalFamilies) &&
    !requiresDistinctDataSource(systemName, methodName, physicalFamilies) &&
    !physicalFamilies.some((family) => requiresSpecialSafetyEvidence(family, evidenceText) && !outcomesShareExperimentPath(systemName, methodName, [family], evidenceText))
  );
}

function outcomesShareExperimentPath(systemName: string, methodName: string, outcomeFamilies: string[], evidenceText: string): boolean {
  if (outcomeFamilies.includes("noise") && !hasAcousticEvidence(evidenceText)) return false;
  if (outcomeFamilies.includes("safety")) return false;
  if (systemName === "hvac-diffuser") return outcomeFamilies.every((family) => ["pressure", "airflow", "thermal", "model-metric", "vague-efficiency"].includes(family));
  if (systemName === "battery-pack" || systemName === "cooling-plate") return outcomeFamilies.every((family) => ["thermal", "model-metric", "vague-efficiency"].includes(family));
  if (systemName === "robotic-gripper") return outcomeFamilies.every((family) => ["manipulation", "control-disturbance", "model-metric", "vague-efficiency"].includes(family));
  if (systemName === "motor-drive") return outcomeFamilies.every((family) => ["control-disturbance", "vague-efficiency", "model-metric"].includes(family));
  if (systemName === "composite-laminate") {
    return methodName.includes("fatigue") && outcomeFamilies.every((family) => ["fatigue", "failure-growth"].includes(family)) && textMentions(evidenceText, ["fatigue", "delamination", "crack"]);
  }
  if (systemName === "pump" || systemName === "heat-exchanger") return outcomeFamilies.every((family) => ["pressure", "airflow", "thermal", "vague-efficiency"].includes(family));
  if (systemName === "additive-manufacturing") return outcomeFamilies.every((family) => ["manufacturing-quality", "model-metric"].includes(family));
  return false;
}

function requiresDistinctPhysics(systemName: string, methodName: string, outcomeFamilies: string[]): boolean {
  if (outcomeFamilies.includes("noise")) return true;
  if (outcomeFamilies.includes("safety")) return true;
  if (systemName === "composite-laminate" && outcomeFamilies.includes("structural") && outcomeFamilies.includes("fatigue")) return true;
  return methodName === "pid-control" && outcomeFamilies.includes("vague-efficiency") && !outcomeFamilies.includes("control-disturbance");
}

function requiresDistinctDataSource(systemName: string, methodName: string, outcomeFamilies: string[]): boolean {
  if (systemName === "composite-laminate" && outcomeFamilies.includes("structural") && outcomeFamilies.includes("failure-growth")) return true;
  return methodName === "benchmarking" && outcomeFamilies.includes("manufacturing-quality") && outcomeFamilies.includes("thermal");
}

function mergedConceptTitle(method: string, system: string): string {
  const methodName = methodFamily(method);
  const systemName = systemFamily(system);
  if (systemName === "hvac-diffuser") return "Multi-objective Surrogate Modeling For HVAC Diffuser Airflow Performance";
  if ((systemName === "battery-pack" || systemName === "cooling-plate") && ["thermal-modeling", "cfd"].includes(methodName)) return "Multi-objective Thermal Modeling For Battery Pack Cooling Performance";
  if (systemName === "robotic-gripper" && ["pid-control", "benchmarking"].includes(methodName)) return "Multi-objective Force-control Benchmarking For Robotic Gripper Manipulation";
  if (systemName === "composite-laminate" && methodName === "fatigue-testing") return "Multi-objective Fatigue Modeling For Composite Laminate Durability";
  if (systemName === "motor-drive" && methodName === "pid-control") return "Multi-objective PID Control Benchmarking For Motor-drive Response";
  return titleCase(`Multi-objective ${methodName.replace(/-/g, " ")} for ${system} performance`);
}

function mergedConceptExperiment(method: string, system: string, outcomes: string[], dataSource: string): string {
  const systemName = systemFamily(system);
  const outcomeText = readableList(outcomes.slice(0, 3));
  if (systemName === "hvac-diffuser") return "Generate a small CFD dataset varying diffuser angle, inlet velocity, and room layout, then train surrogate models to predict pressure drop, airflow uniformity, and thermal comfort.";
  if (systemName === "battery-pack" || systemName === "cooling-plate") return "Generate a small thermal simulation dataset varying cooling-channel geometry and heat generation rate, then evaluate thermal models against temperature uniformity and peak cell temperature.";
  if (systemName === "robotic-gripper") return "Build or simulate gripper trials varying object size and grip force, then compare control methods using tracking error and manipulation success rate.";
  if (systemName === "composite-laminate") return "Analyze composite laminate fatigue data varying ply orientation and load level, then compare models using fatigue life and delamination-growth error.";
  if (systemName === "motor-drive") return "Benchmark motor-drive control using reference trajectory and disturbance-input tests, then compare tracking error and disturbance rejection.";
  return `Generate a small ${dataSource} varying ${designVariablesForSystem(systemName)}, then evaluate ${method} against ${outcomeText}.`;
}

function designVariablesForSystem(systemName: string): string {
  if (systemName === "pump") return "impeller geometry, flow rate, and operating speed";
  if (systemName === "heat-exchanger") return "channel geometry, inlet temperature, and flow rate";
  if (systemName === "additive-manufacturing") return "process parameters, scan speed, and layer thickness";
  if (systemName === "bearing") return "load, speed, and lubrication condition";
  if (systemName === "gear-train") return "load, speed, and gear geometry";
  return "the most important geometry and operating variables";
}

function defaultOutcomesForSystem(systemName: string, evidenceText: string, detectedOutcomes: string[]): string[] {
  const candidates: Record<string, string[]> = {
    "hvac-diffuser": ["pressure drop reduction", "airflow uniformity", "thermal comfort"],
    "battery-pack": ["temperature uniformity", "heat generation", "peak cell temperature"],
    "cooling-plate": ["temperature uniformity", "heat generation", "peak cell temperature"],
    "robotic-gripper": ["grip force", "tracking error reduction", "manipulation success"],
    "composite-laminate": ["fatigue life prediction", "delamination growth"],
    "motor-drive": ["tracking error reduction", "disturbance rejection", "energy use reduction"],
    "pump": ["pressure drop reduction", "flow uniformity", "energy use reduction"],
    "heat-exchanger": ["pressure drop reduction", "thermal comfort", "temperature uniformity"],
    "additive-manufacturing": ["defect rate", "surface roughness", "print strength"]
  };
  const defaults = candidates[systemName] ?? [];
  const supportedDefaults = defaults.filter((outcome) => hasPhysicalOutcomeEvidence(outcome, evidenceText));
  const safeDetected = detectedOutcomes.filter((outcome) => !["model-metric", "vague-efficiency", "noise", "safety", "structural"].includes(outcomeFamily(outcome)));
  return uniqueTokens([...supportedDefaults, ...safeDetected]).slice(0, 3);
}

function mergedDataSourceForConcept(best: ProjectCandidate, ingredients: ProjectIngredients): string {
  const systemName = systemFamily(ingredients.systems[0] ?? best.ingredients.systems[0] ?? "");
  if (systemName === "hvac-diffuser") return "CFD dataset";
  if (systemName === "battery-pack" || systemName === "cooling-plate") return "thermal simulation dataset";
  if (systemName === "robotic-gripper") return "gripper trial dataset";
  if (systemName === "composite-laminate") return "fatigue test dataset";
  if (systemName === "motor-drive") return "control benchmark dataset";
  if (systemName === "heat-exchanger") return "thermal simulation dataset";
  if (systemName === "pump") return "flow simulation dataset";
  if (systemName === "additive-manufacturing") return "process parameter dataset";
  return ingredients.materialsOrDatasets[0] ?? "simulation dataset";
}

function groupEvidenceText(group: ScoredProjectCandidate[]): string {
  return group.flatMap((candidate) => candidate.supportingWorks.map((work) => work.compactText)).join(" ");
}

function readableList(items: string[]): string {
  if (!items.length) return "measurable performance outputs";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function projectIdeaFromCandidate(candidate: ScoredProjectCandidate): ProjectIdea {
  const supportingPaperIds = candidate.supportingWorks.map((work) => work.id);
  const supportingClusterIds = candidate.clusters.map((cluster) => cluster.id);
  const clusterLabel = candidate.clusters.map((cluster) => cluster.label).join(" + ");
  const limitations = [
    "Distinctive within retrieved OpenAlex evidence, not proof of novelty.",
    "Shared references are supporting context only and may include methods or review papers.",
    ...candidate.ingredients.limitationSignals.map((signal) => `Limitation signal: ${signal}.`),
    ...queryFocusLimitations(candidate.queryFocus)
  ];

  return {
    title: candidate.title,
    description: candidate.description,
    difficulty: candidate.difficulty,
    requiredBackground: requiredBackgroundFor(candidate.difficulty === "advanced" ? "publish" : "build-project", clusterLabel),
    supportingPaperIds,
    supportingClusterIds,
    reasonCodes: uniqueTokens([...buildIdeaReasonCodes(candidate.supportingWorks), ...candidate.distinctivenessSignals.map((signal) => normalizeTitle(signal).replace(/\s+/g, "-"))]),
    whyNow: buildTechnicalGrounding(candidate),
    mvpVersion: candidate.firstExperiment,
    confidence: candidate.confidence,
    traceability: {
      supportingPaperIds,
      supportingClusterIds,
      supportingReferenceIds: candidate.supportingReferenceIds,
      evidenceTypes: candidate.evidenceTypes,
      evidenceNote: candidate.supportingReferenceIds.length
        ? `Why grounded: supported by ${supportingPaperIds.length} papers, ${supportingClusterIds.length} cluster(s), and ${candidate.supportingReferenceIds.length} shared references that passed deterministic gates.`
        : `Why grounded: supported by ${supportingPaperIds.length} papers and ${supportingClusterIds.length} cluster(s); no shared reference evidence passed the graph gates.`,
      limitations
    },
    distinctivenessScore: rounded(candidate.distinctivenessScore),
    specificityScore: rounded(candidate.specificityScore),
    evidenceScore: rounded(candidate.evidenceScore),
    executionFitScore: rounded(candidate.executionFitScore),
    traceabilityScore: rounded(candidate.traceabilityScore),
    firstExperiment: candidate.firstExperiment,
    projectType: candidate.projectType,
    distinctivenessSignals: candidate.distinctivenessSignals,
    projectIngredients: candidate.ingredients
  };
}

function buildTechnicalGrounding(candidate: ScoredProjectCandidate): string {
  const method = candidate.ingredients.methods[0] ?? "the method";
  const system = candidate.ingredients.systems[0] ?? candidate.ingredients.applications[0] ?? "the system";
  const outcomes = candidate.ingredients.outcomes
    .filter((outcome) => !["model-metric", "vague-efficiency"].includes(outcomeFamily(outcome)))
    .slice(0, 3);
  const outcomeText = outcomes.length ? outcomes.join(", ") : "a repeatable model metric";
  return `${titleCase(system)} appears with ${method} and ${outcomeText} signals in ${candidate.supportingWorks.length} supporting paper(s).`;
}

function projectConceptKey(candidate: ProjectCandidate): string {
  return [
    methodFamily(candidate.ingredients.methods[0] ?? ""),
    systemFamily(candidate.ingredients.systems[0] ?? candidate.ingredients.applications[0] ?? "")
  ].join("|");
}

function uniqueWorks(works: NormalizedWork[]): NormalizedWork[] {
  const seen = new Set<string>();
  return works.filter((work) => {
    if (seen.has(work.id)) return false;
    seen.add(work.id);
    return true;
  });
}

function uniqueClusters(clusters: TopicCluster[]): TopicCluster[] {
  const seen = new Set<string>();
  return clusters.filter((cluster) => {
    if (seen.has(cluster.id)) return false;
    seen.add(cluster.id);
    return true;
  });
}

function mergeManyProjectIngredients(items: ProjectIngredients[]): ProjectIngredients {
  return {
    methods: uniqueTokens(items.flatMap((item) => item.methods)).slice(0, 5),
    systems: uniqueTokens(items.flatMap((item) => item.systems)).slice(0, 5),
    applications: uniqueTokens(items.flatMap((item) => item.applications)).slice(0, 5),
    outcomes: uniqueTokens(items.flatMap((item) => item.outcomes)).slice(0, 6),
    materialsOrDatasets: uniqueTokens(items.flatMap((item) => item.materialsOrDatasets)).slice(0, 5),
    limitationSignals: uniqueTokens(items.flatMap((item) => item.limitationSignals)).slice(0, 5)
  };
}

export function computeProjectSpecificityScore(ingredients: ProjectIngredients): number {
  const hasMethod = ingredients.methods.length ? 1 : 0;
  const hasSystemOrApplication = ingredients.systems.length || ingredients.applications.length ? 1 : 0;
  const hasMeasurableOutcome = ingredients.outcomes.length ? 1 : 0;
  return 0.35 * hasMethod + 0.35 * hasSystemOrApplication + 0.3 * hasMeasurableOutcome;
}

function computeEvidenceScore(supportingWorks: NormalizedWork[], supportingReferenceIds: string[]): number {
  const directPaperSupportScore = clamp01(supportingWorks.length / 4);
  const relevanceSupportScore = clamp01(average(supportingWorks.map((work) => work.relevanceScore)));
  const recentInfluenceSupportScore = clamp01(average(supportingWorks.map((work) => work.recentInfluenceScore)));
  const citationNetworkSupportScore = clamp01(Math.max(supportingReferenceIds.length / 3, average(supportingWorks.map((work) => work.graphSupportScore))));
  return (
    0.4 * directPaperSupportScore +
    0.25 * relevanceSupportScore +
    0.2 * recentInfluenceSupportScore +
    0.15 * citationNetworkSupportScore
  );
}

function computeExecutionFitScore(candidate: ProjectCandidate): number {
  const text = normalizeTitle([candidate.firstExperiment, candidate.projectType, candidate.ingredients.materialsOrDatasets.join(" ")].join(" "));
  let score = 0.35;
  if (/(simulate|generate|cfd|thermal|model|train)/.test(text)) score += 0.2;
  if (/(dataset|sensor|benchmark|compare|analyze|logs|cases|data)/.test(text)) score += 0.2;
  if (/(build|prototype|test|measure)/.test(text)) score += 0.1;
  if (candidate.ingredients.outcomes.length) score += 0.1;
  if (/(deployment|clinical|full scale|proprietary)/.test(text)) score -= 0.25;
  return clamp01(score);
}

function computeDistinctivenessScore(candidate: ProjectCandidate, allWorks: NormalizedWork[]): number {
  const method = candidate.ingredients.methods[0] ?? "";
  const system = candidate.ingredients.systems[0] ?? candidate.ingredients.applications[0] ?? "";
  const outcome = candidate.ingredients.outcomes[0] ?? "";
  const pairs = [
    [method, system],
    [method, outcome],
    [system, outcome]
  ].filter((pair) => pair.every(Boolean));
  if (!pairs.length) return 0;

  const titleTexts = allWorks.map((work) => work.normalizedTitle);
  const pairScores = pairs.map(([left, right]) => {
    const leftTokens = tokenize(left);
    const rightTokens = tokenize(right);
    const repeats = titleTexts.filter((title) => {
      const titleTokens = new Set(tokenize(title));
      return leftTokens.some((token) => titleTokens.has(token)) && rightTokens.some((token) => titleTokens.has(token));
    }).length;
    return 1 - clamp01(repeats / Math.max(1, allWorks.length * 0.35));
  });

  return clamp01(average(pairScores));
}

function computeTraceabilityScore(candidate: ProjectCandidate): number {
  const hasPapers = candidate.supportingWorks.length ? 1 : 0;
  const hasClusters = candidate.clusters.length ? 1 : 0;
  const hasReferences = candidate.supportingReferenceIds.length ? 1 : 0;
  const hasEvidenceTypes = candidate.evidenceTypes.length ? 1 : 0;
  const hasLimitations = candidate.ingredients.limitationSignals.length ? 1 : 0.7;
  return 0.3 * hasPapers + 0.25 * hasClusters + 0.15 * hasReferences + 0.2 * hasEvidenceTypes + 0.1 * hasLimitations;
}

function projectConfidence(candidate: ProjectCandidate, evidenceScore: number): Confidence {
  const directPapers = candidate.supportingWorks.length;
  const averageRelevance = average(candidate.supportingWorks.map((work) => work.relevanceScore));
  const hasRecentInfluence = candidate.supportingWorks.some((work) => work.recentInfluenceScore >= 0.7);
  const hasNetworkSupport = candidate.supportingReferenceIds.length > 0 || candidate.supportingWorks.some((work) => work.graphSupportScore > 0);
  let confidence: Confidence = evidenceScore >= 0.72 && averageRelevance >= 0.55 ? "strong" : evidenceScore >= 0.45 ? "moderate" : "sparse";

  if (directPapers < 2) {
    confidence = averageRelevance >= 0.7 && hasNetworkSupport ? "moderate" : "sparse";
  }
  if (confidence === "moderate" && directPapers < 2 && averageRelevance < 0.7) confidence = "sparse";
  if (confidence === "strong" && (directPapers < 4 || !hasRecentInfluence || !hasNetworkSupport)) confidence = "moderate";
  if (candidate.clusters.some((cluster) => cluster.averageRelevanceScore < 0.45) && confidence === "strong") confidence = "moderate";
  if (candidate.queryFocus.label === "broad" && confidence === "strong") confidence = "moderate";
  if (candidate.queryFocus.label === "sparse") confidence = "sparse";
  return confidence;
}

function buildDistinctivenessSignals(candidate: ProjectCandidate, distinctivenessScore: number): string[] {
  const signals: string[] = [];
  if (candidate.ingredients.methods.length && (candidate.ingredients.systems.length || candidate.ingredients.applications.length)) {
    signals.push("specific method/system pairing");
  }
  if (candidate.ingredients.outcomes.length) {
    signals.push("measurable outcome present");
  }
  if (candidate.bridgeSignal) {
    signals.push("cross-cluster bridge");
  }
  if (candidate.supportingWorks.some((work) => new Date().getFullYear() - work.year <= 5)) {
    signals.push("recent-paper support");
  }
  if (candidate.supportingReferenceIds.length) {
    signals.push("shared-reference support");
  }
  if (distinctivenessScore >= 0.65) {
    signals.push("not repeated across top paper titles");
  }
  return signals;
}

function projectEvidenceTypes(supportingWorks: NormalizedWork[], supportingReferenceIds: string[]): EvidenceType[] {
  const evidenceTypes: EvidenceType[] = ["cluster-signal"];
  if (supportingWorks.some((work) => new Date().getFullYear() - work.year <= 5)) {
    evidenceTypes.push("recent-paper");
  }
  if (supportingWorks.some((work) => work.citationPercentileScore >= 0.85)) {
    evidenceTypes.push("high-normalized-citation");
  }
  if (supportingWorks.some((work) => work.graphSupportScore > 0) || supportingReferenceIds.length) {
    evidenceTypes.push("shared-reference");
  }
  return evidenceTypes;
}

function projectTypeFor(method: string, system: string, materialOrDataset: string): NonNullable<ProjectIdea["projectType"]> {
  const text = normalizeTitle([method, system, materialOrDataset].join(" "));
  if (text.includes("surrogate") || text.includes("thermal modeling") || text.includes("cfd")) return "modeling";
  if (text.includes("benchmark") || text.includes("data")) return "benchmark";
  if (text.includes("fatigue testing") || text.includes("experimental")) return "experimental-test";
  if (text.includes("topology") || text.includes("optimization")) return "design-optimization";
  if (text.includes("gripper") || text.includes("motor") || text.includes("pump")) return "prototype-design";
  return "dataset-analysis";
}

function buildFirstExperiment(method: string, system: string, materialOrDataset: string, outcome: string): string {
  const action = method.includes("surrogate") ? "Generate" : method.includes("benchmark") ? "Compare" : method.includes("testing") ? "Test" : "Simulate";
  const dataSource = materialOrDataset || datasetForMethod(method);
  return `${action} a small ${datasetPhrase(dataSource)} for ${system}, then evaluate ${method} against ${outcome} as the main metric.`;
}

function buildBenchmarkExperiment(system: string, materialOrDataset: string, outcome: string): string {
  return `Compare two ${system} baselines using ${materialOrDataset || "published data"} and report ${outcome} with one repeatable metric.`;
}

function buildValidationExperiment(method: string, system: string, materialOrDataset: string, outcome: string): string {
  if (method.toLowerCase().includes("validation")) {
    return `Validate one ${system} case using ${materialOrDataset || "paper data"} and measure ${outcome} against a baseline.`;
  }
  return `Validate ${method} on one ${system} case using ${materialOrDataset || "paper data"} and measure ${outcome} against a baseline.`;
}

function datasetForMethod(method: string): string {
  const normalized = normalizeTitle(method);
  if (normalized.includes("cfd") || normalized.includes("surrogate")) return "CFD dataset";
  if (normalized.includes("fatigue")) return "fatigue test data";
  if (normalized.includes("thermal")) return "simulation dataset";
  return "simulation cases";
}

function datasetPhrase(dataSource: string): string {
  const normalized = normalizeTitle(dataSource);
  if (/(dataset|data|cases|logs)$/.test(normalized)) {
    return dataSource;
  }
  if (normalized.includes("cells")) {
    return `${dataSource} dataset`;
  }
  if (normalized.includes("materials")) {
    return `${dataSource} dataset`;
  }
  return `${dataSource} dataset`;
}

function trimProjectTitle(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_PROJECT_TITLE_WORDS).join(" ");
}

function isClusterLabelParaphrase(title: string, clusters: TopicCluster[]): boolean {
  const normalizedTitle = normalizeTitle(title);
  return clusters.some((cluster) => {
    const label = normalizeTitle(cluster.label);
    if (!label) return false;
    return normalizedTitle === label || (normalizedTitle.includes(label) && wordCount(title) <= wordCount(cluster.label) + 3);
  });
}

function countTrue(values: boolean[]): number {
  return values.filter(Boolean).length;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

export function buildQueryFocus(request: ResearchMapRequest, works: NormalizedWork[], clusters: TopicCluster[]): QueryFocus {
  const usableWorks = works.length;
  const medianRelevance = Number(median(works.map((work) => work.relevanceScore)).toFixed(2));
  const clusterCount = clusters.length;
  const weakClusterCount = clusters.filter((cluster) => cluster.paperCount <= 2 || cluster.averageRelevanceScore < 0.45).length;
  const weakClusterShare = Number((clusterCount ? weakClusterCount / clusterCount : 0).toFixed(2));
  const topClusterShare = Number((usableWorks ? Math.max(0, ...clusters.map((cluster) => cluster.paperCount)) / usableWorks : 0).toFixed(2));
  const label = classifyQueryFocus({ usableWorks, medianRelevance, clusterCount, weakClusterShare, topClusterShare });

  return {
    label,
    medianRelevance,
    clusterCount,
    weakClusterCount,
    weakClusterShare,
    topClusterShare,
    usableWorks,
    reason: buildQueryFocusReason(label, {
      usableWorks,
      medianRelevance,
      clusterCount,
      weakClusterCount,
      weakClusterShare,
      topClusterShare
    }),
    suggestions: buildQueryFocusSuggestions(request.topic)
  };
}

function classifyQueryFocus(input: {
  usableWorks: number;
  medianRelevance: number;
  clusterCount: number;
  weakClusterShare: number;
  topClusterShare: number;
}): QueryFocus["label"] {
  if (input.usableWorks < 25) {
    return "sparse";
  }
  if (input.medianRelevance >= 0.6 && input.topClusterShare >= 0.3 && input.weakClusterShare < 0.5) {
    return "focused";
  }
  if (input.medianRelevance < 0.45 || input.weakClusterShare >= 0.6 || input.clusterCount >= 12) {
    return "broad";
  }
  return "moderate";
}

function buildQueryFocusReason(
  label: QueryFocus["label"],
  metrics: Pick<QueryFocus, "usableWorks" | "medianRelevance" | "clusterCount" | "weakClusterCount" | "weakClusterShare" | "topClusterShare">
): string {
  if (label === "sparse") {
    return `Only ${metrics.usableWorks} usable works were found, so citation and cluster signals may be unstable.`;
  }
  if (label === "focused") {
    return `Median relevance is ${metrics.medianRelevance.toFixed(2)} and the top cluster contains ${(metrics.topClusterShare * 100).toFixed(0)}% of usable works.`;
  }
  if (label === "broad") {
    return `Results split across ${metrics.clusterCount} clusters, ${metrics.weakClusterCount} appear weak, and median relevance is ${metrics.medianRelevance.toFixed(2)}.`;
  }
  return `Median relevance is ${metrics.medianRelevance.toFixed(2)} and results form several usable clusters.`;
}

function queryFocusLimitations(queryFocus: QueryFocus): string[] {
  if (queryFocus.label === "broad") {
    return ["The source query was broad, so this idea should be treated as exploratory."];
  }
  if (queryFocus.label === "sparse") {
    return ["Few usable works were found, so supporting evidence is limited."];
  }
  return [];
}

export function computeMapConfidence(usablePapers: number, medianRelevance: number): Confidence {
  if (usablePapers >= 75 && medianRelevance >= 0.55) {
    return "strong";
  }
  if (usablePapers >= 25) {
    return "moderate";
  }
  return "sparse";
}

export function computeProjectConfidence(supportingPaperCount: number, supportingClusterIds: string[]): Confidence {
  if (supportingPaperCount >= 5 && supportingClusterIds.length >= 2) {
    return "strong";
  }
  if (supportingPaperCount >= 3) {
    return "moderate";
  }
  return "sparse";
}

type RequestBudget = {
  readonly max: 7;
  used: number;
  remaining: () => number;
  tryUse: (count: number) => boolean;
};

function createRequestBudget(): RequestBudget {
  return {
    max: REQUEST_BUDGET_MAX,
    used: INITIAL_OPENALEX_REQUESTS,
    remaining() {
      return Math.max(0, this.max - this.used);
    },
    tryUse(count: number) {
      if (this.used + count > this.max) {
        return false;
      }
      this.used += count;
      return true;
    }
  };
}

export function calculateGraphSupportScore(input: {
  sharedReferenceHit: boolean;
  seedReferenceFrequencyNormalized: number;
  topicOverlapHit: boolean;
  citationPercentileHit: boolean;
}): number {
  return Math.min(
    GRAPH_BOOST_CAP,
    (input.sharedReferenceHit ? 0.02 : 0) +
      0.015 * clamp01(input.seedReferenceFrequencyNormalized) +
      (input.topicOverlapHit ? 0.01 : 0) +
      (input.citationPercentileHit ? 0.005 : 0)
  );
}

export function passesSharedReferenceRelevanceGate(input: {
  titleOverlapScore: number;
  topicOverlapScore: number;
  keywordOverlapScore: number;
  citationPercentileValue: number | null;
  embeddingSimilarityScore?: number | null;
}): boolean {
  return (
    input.titleOverlapScore >= 0.25 ||
    input.topicOverlapScore >= 0.34 ||
    input.keywordOverlapScore >= 0.25 ||
    (input.citationPercentileValue ?? 0) >= 0.85 ||
    (input.embeddingSimilarityScore ?? 0) >= 0.7
  );
}

async function buildCitationNetworkSignals(
  request: ResearchMapRequest,
  seedWorks: NormalizedWork[],
  clusters: TopicCluster[],
  requestBudget: RequestBudget,
  referenceFetcher: (ids: string[]) => Promise<OpenAlexWork[]>
): Promise<CitationNetworkSignals> {
  const seedPaperIds = seedWorks.map((work) => work.id);
  const referenceCounts = new Map<string, { ids: Set<string> }>();
  for (const seed of seedWorks) {
    for (const referenceId of seed.referencedWorks) {
      const normalizedReferenceId = normalizeOpenAlexWorkId(referenceId);
      const entry = referenceCounts.get(normalizedReferenceId) ?? { ids: new Set<string>() };
      entry.ids.add(seed.id);
      referenceCounts.set(normalizedReferenceId, entry);
    }
  }

  const sharedReferenceEntries = Array.from(referenceCounts.entries())
    .map(([id, entry]) => ({ id, referencedBySeedPaperIds: Array.from(entry.ids), referenceFrequency: entry.ids.size }))
    .filter((entry) => entry.referenceFrequency >= SHARED_REFERENCE_MIN_FREQUENCY)
    .sort((a, b) => b.referenceFrequency - a.referenceFrequency)
    .slice(0, SHARED_REFERENCE_FETCH_LIMIT);

  const chunks = chunk(sharedReferenceEntries.map((entry) => entry.id), OPENALEX_ID_CHUNK_SIZE);
  const fetchedWorks: OpenAlexWork[] = [];
  for (const ids of chunks) {
    if (!requestBudget.tryUse(1)) {
      break;
    }
    try {
      fetchedWorks.push(...(await referenceFetcher(ids)));
    } catch {
      // The graph layer is supporting evidence; the map should still render if reference fetches fail.
    }
  }

  const entryById = new Map(sharedReferenceEntries.map((entry) => [entry.id, entry]));
  const queryContext = buildQueryContext(request, clusters);
  const dominantTopics = new Set(clusters.slice(0, 6).flatMap((cluster) => tokenize(cluster.label)));
  const topSharedReferences = fetchedWorks
    .map((work) => {
      const id = normalizeOpenAlexWorkId(work.id);
      const entry = entryById.get(id);
      const title = work.display_name ?? "Untitled reference";
      const titleOverlapScore = jaccard(tokenize(title), queryContext);
      const topicOverlapScore = topicOverlap(work, dominantTopics);
      const keywordOverlapScore = keywordOverlap(work, queryContext);
      const citationNormalizedPercentile = work.citation_normalized_percentile?.value ?? null;
      const citationPercentileHit = (citationNormalizedPercentile ?? 0) >= 0.85;
      const relevanceGatePassed = passesSharedReferenceRelevanceGate({
        titleOverlapScore,
        topicOverlapScore,
        keywordOverlapScore,
        citationPercentileValue: citationNormalizedPercentile
      });
      const evidenceTypes: SharedReferenceEvidence["evidenceTypes"] = ["shared-reference"];
      if (topicOverlapScore >= 0.34) {
        evidenceTypes.push("topic-overlap");
      }
      if (citationPercentileHit) {
        evidenceTypes.push("citation-percentile");
      }
      if (sourceQualityScore(work.type) >= 0.75) {
        evidenceTypes.push("source-quality");
      }
      return {
        id: work.id,
        title,
        publicationYear: work.publication_year ?? null,
        citedByCount: work.cited_by_count ?? null,
        citationNormalizedPercentile,
        fwci: work.fwci ?? null,
        referencedBySeedPaperIds: entry?.referencedBySeedPaperIds ?? [],
        referenceFrequency: entry?.referenceFrequency ?? 0,
        relevanceGatePassed,
        evidenceTypes
      };
    })
    .filter((reference) => reference.relevanceGatePassed)
    .sort((a, b) => b.referenceFrequency - a.referenceFrequency);

  const seedPapersWithReferences = seedWorks.filter((work) => work.referencedWorks.length > 0).length;
  return {
    seedPaperIds,
    seedPaperCount: seedWorks.length,
    seedPapersWithReferences,
    fetchedReferenceCount: fetchedWorks.length,
    sharedReferenceCount: sharedReferenceEntries.length,
    graphCoverageRatio: seedWorks.length ? Number((seedPapersWithReferences / seedWorks.length).toFixed(3)) : 0,
    requestBudgetUsed: requestBudget.used,
    requestBudgetMax: REQUEST_BUDGET_MAX,
    topSharedReferences,
    limitations: [
      "Reference overlap is supporting evidence only, not proof of field importance.",
      "Shared references must pass deterministic relevance gates before they support project ideas.",
      requestBudget.remaining() === 0 ? "OpenAlex request budget was exhausted, so optional graph or citation fallbacks may be skipped." : ""
    ].filter(Boolean)
  };
}

function applyGraphSupport(works: NormalizedWork[], signals: CitationNetworkSignals): NormalizedWork[] {
  const referenceByShortId = new Map(signals.topSharedReferences.map((reference) => [normalizeOpenAlexWorkId(reference.id), reference]));
  return works.map((work) => {
    const graphSupportSeedTotal = signals.seedPaperCount;
    const reference = referenceByShortId.get(normalizeOpenAlexWorkId(work.id));
    if (!reference) {
      const rankScore = work.foundationalScore;
      return {
        ...work,
        graphSupportScore: 0,
        graphSupportSeedCount: 0,
        graphSupportSeedTotal,
        rankScore,
        scoreContributions: foundationalContributions({ ...work, graphSupportScore: 0, rankScore })
      };
    }
    const seedReferenceFrequencyNormalized = signals.seedPaperCount ? reference.referenceFrequency / signals.seedPaperCount : 0;
    const graphSupportScore = calculateGraphSupportScore({
      sharedReferenceHit: true,
      seedReferenceFrequencyNormalized,
      topicOverlapHit: reference.evidenceTypes.includes("topic-overlap"),
      citationPercentileHit: (reference.citationNormalizedPercentile ?? 0) >= 0.85
    });
    return {
      ...work,
      graphSupportScore,
      graphSupportSeedCount: reference.referenceFrequency,
      graphSupportSeedTotal,
      rankScore: work.foundationalScore + graphSupportScore,
      scoreContributions: foundationalContributions({
        ...work,
        graphSupportScore,
        graphSupportSeedCount: reference.referenceFrequency,
        graphSupportSeedTotal,
        rankScore: work.foundationalScore + graphSupportScore
      })
    };
  });
}

function dedupeWorks(works: NormalizedWork[]): NormalizedWork[] {
  const seen = new Set<string>();
  return works.filter((work) => {
    if (seen.has(work.id)) {
      return false;
    }
    seen.add(work.id);
    return true;
  });
}

function buildDataQuality(
  rawWorks: OpenAlexWork[],
  usableWorks: NormalizedWork[],
  deduplicatedWorks: number,
  excludedRetractedWorks: number
): DataQuality {
  return {
    usableWorks: usableWorks.length,
    totalWorksFetched: rawWorks.length,
    worksWithAbstract: usableWorks.filter((work) => work.hasAbstract).length,
    worksWithDoi: usableWorks.filter((work) => work.doi).length,
    deduplicatedWorks,
    excludedRetractedWorks
  };
}

function buildWarnings(dataQuality: DataQuality, confidence: Confidence, semanticEnabled: boolean, judgeSignals: JudgeSignals): string[] {
  const warnings: string[] = [];
  if (!semanticEnabled) {
    warnings.push("Semantic ranking unavailable; using keyword and citation scoring only.");
  }
  if (judgeSignals.enabled && judgeSignals.failedBatchCount > 0) {
    warnings.push("LLM relevance judge unavailable for some batches; using embedding/keyword relevance for those papers.");
  }
  if (judgeSignals.unjudgedNoAbstractCount > 0) {
    warnings.push(`${judgeSignals.unjudgedNoAbstractCount} paper(s) had no abstract and could not be topic-verified.`);
  }
  if (judgeSignals.filteredOffTopicCount > 0) {
    warnings.push(`${judgeSignals.filteredOffTopicCount} off-topic paper(s) removed by relevance judge.`);
  }
  if (confidence === "sparse") {
    warnings.push("Sparse data: this topic returned fewer than 25 usable works, so recommendations should be treated as exploratory.");
  }
  if (dataQuality.usableWorks < 30) {
    warnings.push("Below minimum useful sample size: try a broader topic or wider year range.");
  }
  if (dataQuality.totalWorksFetched > 0 && dataQuality.deduplicatedWorks / dataQuality.totalWorksFetched > 0.2) {
    warnings.push("High deduplication: multiple records may describe the same paper or version.");
  }
  if (dataQuality.usableWorks > 0 && dataQuality.worksWithAbstract / dataQuality.usableWorks < 0.4) {
    warnings.push("Many works lack abstracts, so clustering relies more heavily on titles, topics, and keywords.");
  }
  return warnings;
}

function buildCitationSignals(works: NormalizedWork[], clusters: TopicCluster[], confidence: Confidence) {
  const currentYear = new Date().getFullYear();
  const topClusterByPaperCount = clusters.slice().sort((a, b) => b.paperCount - a.paperCount)[0]?.label ?? null;
  const topClusterByRecentInfluence = clusters.slice().sort((a, b) => b.averageRecentInfluenceScore - a.averageRecentInfluenceScore)[0]?.label ?? null;

  return {
    totalUsableWorks: works.length,
    medianCitationsPerYear: Number(median(works.map((work) => work.citationsPerYear)).toFixed(2)),
    topClusterByPaperCount,
    topClusterByRecentInfluence,
    recentPaperShare: works.length ? works.filter((work) => currentYear - work.year <= 5).length / works.length : 0,
    confidence
  };
}

export function calculateDirectionMomentumScore(cluster: Pick<TopicCluster, "paperCount" | "recentPaperShare" | "averageRecentInfluenceScore" | "averageRelevanceScore">): number {
  const recentPaperShareScore = cluster.recentPaperShare;
  const paperCountConfidenceScore = Math.min(1, cluster.paperCount / 8);
  return clamp01(
    0.35 * recentPaperShareScore +
      0.3 * cluster.averageRecentInfluenceScore +
      0.2 * cluster.averageRelevanceScore +
      0.15 * paperCountConfidenceScore
  );
}

export function getSummaryConfidence(paperCount: number, recentPaperShare: number): Confidence {
  if (paperCount >= 8 && recentPaperShare >= 0.55) {
    return "strong";
  }
  if (paperCount >= 3) {
    return "moderate";
  }
  return "sparse";
}

export function getLowerActivityConfidence(paperCount: number): Confidence {
  if (paperCount >= 8) {
    return "moderate";
  }
  return "sparse";
}

export function buildResearchDirectionSummary(clusters: TopicCluster[]): ResearchDirectionSummary {
  const eligibleClusters = clusters.filter((cluster) => cluster.paperCount >= 3);
  const signals = eligibleClusters.map((cluster) => {
    const directionMomentumScore = calculateDirectionMomentumScore(cluster);
    return {
      cluster,
      directionMomentumScore
    };
  });

  const strongerRecentActivity: SummarySignal[] = signals
    .filter((signal) => signal.directionMomentumScore >= 0.7)
    .sort((a, b) => b.directionMomentumScore - a.directionMomentumScore)
    .slice(0, 3)
    .map(({ cluster, directionMomentumScore }) => ({
      label: cluster.label,
      reason: `${cluster.label} has a stronger recent-paper signal in this result set, with ${(cluster.recentPaperShare * 100).toFixed(0)}% recent-paper share and ${cluster.paperCount} supporting works.`,
      paperCount: cluster.paperCount,
      recentPaperShare: Number(cluster.recentPaperShare.toFixed(3)),
      averageRecentInfluenceScore: Number(cluster.averageRecentInfluenceScore.toFixed(3)),
      averageRelevanceScore: Number(cluster.averageRelevanceScore.toFixed(3)),
      directionMomentumScore: Number(directionMomentumScore.toFixed(3)),
      supportingPaperIds: cluster.paperIds,
      confidence: getSummaryConfidence(cluster.paperCount, cluster.recentPaperShare)
    }));

  const weakerRecentPaperSignal: SummarySignal[] = signals
    .filter((signal) => signal.directionMomentumScore <= 0.4)
    .sort((a, b) => a.directionMomentumScore - b.directionMomentumScore)
    .slice(0, 3)
    .map(({ cluster, directionMomentumScore }) => ({
      label: cluster.label,
      reason: `${cluster.label} has a weaker recent-paper signal in this result set, with ${(cluster.recentPaperShare * 100).toFixed(0)}% recent-paper share across ${cluster.paperCount} supporting works.`,
      paperCount: cluster.paperCount,
      recentPaperShare: Number(cluster.recentPaperShare.toFixed(3)),
      averageRecentInfluenceScore: Number(cluster.averageRecentInfluenceScore.toFixed(3)),
      averageRelevanceScore: Number(cluster.averageRelevanceScore.toFixed(3)),
      directionMomentumScore: Number(directionMomentumScore.toFixed(3)),
      supportingPaperIds: cluster.paperIds,
      confidence: getLowerActivityConfidence(cluster.paperCount)
    }));

  return {
    strongerRecentActivity,
    weakerRecentPaperSignal,
    briefSummary: buildDirectionBrief(strongerRecentActivity, weakerRecentPaperSignal),
    limitations: [
      "These are OpenAlex metadata signals, not proof that a field is growing, abandoned, or guaranteed to produce good projects.",
      "Lower recent-paper signal means weaker activity in this result set, not that researchers have stopped working on the area."
    ]
  };
}

function buildDirectionBrief(strongerRecentActivity: SummarySignal[], weakerRecentPaperSignal: SummarySignal[]): string {
  const strongerLabels = strongerRecentActivity.map((signal) => signal.label).join(", ");
  const weakerLabels = weakerRecentPaperSignal.map((signal) => signal.label).join(", ");

  if (strongerLabels && weakerLabels) {
    return `This result set shows stronger recent activity around ${strongerLabels}, while ${weakerLabels} show weaker recent-paper signals.`;
  }
  if (strongerLabels) {
    return `This result set shows stronger recent activity around ${strongerLabels}.`;
  }
  if (weakerLabels) {
    return `This result set shows weaker recent-paper signals around ${weakerLabels}.`;
  }
  return "No clear direction summary was produced because the cluster evidence did not meet the minimum sample-size and momentum thresholds.";
}

function buildEvidence(
  foundationalPapers: PaperRecommendation[],
  recentInfluencePapers: PaperRecommendation[],
  people: ResearcherRecommendation[],
  clusters: TopicCluster[]
): EvidenceItem[] {
  return [
    ...foundationalPapers.slice(0, 5).map((paper) => ({
      id: `evidence-foundational-${paper.id}`,
      kind: "paper" as const,
      label: paper.title,
      metric: `Foundational score ${paper.score.toFixed(2)} from citations, normalized percentile, relevance, and source type.`,
      sourceIds: [paper.id]
    })),
    ...recentInfluencePapers.slice(0, 5).map((paper) => ({
      id: `evidence-recent-${paper.id}`,
      kind: "paper" as const,
      label: paper.title,
      metric: `Recent influence score ${paper.score.toFixed(2)} from citations per year, recency, relevance, and citation percentile.`,
      sourceIds: [paper.id]
    })),
    ...clusters.slice(0, 5).map((cluster) => ({
      id: `evidence-cluster-${cluster.id}`,
      kind: "cluster" as const,
      label: cluster.label,
      metric: `${cluster.paperCount} papers, ${(cluster.recentPaperShare * 100).toFixed(0)}% recent-paper share.`,
      sourceIds: cluster.paperIds
    })),
    ...people.slice(0, 5).map((person) => ({
      id: `evidence-author-${person.id}`,
      kind: "author" as const,
      label: person.name,
      metric: `${person.relevantPaperCount} relevant works, ${person.risingPaperInvolvementCount} recent-influence works.`,
      sourceIds: person.paperIds
    }))
  ];
}

function toPaperRecommendation(
  work: NormalizedWork,
  score: number,
  reasonCodes: string[],
  facet: "foundational" | "recent-influence" = "foundational"
): PaperRecommendation {
  const countsByYearHistory = buildCitationHistoryFromCountsByYear(work.countsByYear);
  const scoreContributions = facet === "recent-influence" ? recentInfluenceContributions(work) : work.scoreContributions ?? foundationalContributions(work);
  return {
    id: work.id,
    title: work.title,
    year: work.year,
    url: work.url,
    doi: work.doi,
    type: work.type,
    citationCount: work.citationCount,
    citationsPerYear: Number(work.citationsPerYear.toFixed(2)),
    relevanceScore: Number(work.relevanceScore.toFixed(3)),
    semanticRelevanceScore: work.semanticRelevanceScore === null ? null : Number(work.semanticRelevanceScore.toFixed(3)),
    score: Number(score.toFixed(3)),
    reasonCodes: appendDiagnosticReasonCodes(reasonCodes, work),
    authors: work.authors.slice(0, 5),
    citationHistory: countsByYearHistory.history,
    citationHistoryStatus: countsByYearHistory.status,
    citationHistorySource: countsByYearHistory.source,
    citationHistoryNote: countsByYearHistory.note,
    graphSupportScore: Number(work.graphSupportScore.toFixed(3)),
    graphSupportNote: work.graphSupportSeedCount
      ? `Graph support: cited by ${work.graphSupportSeedCount} of ${Math.max(1, work.graphSupportSeedTotal)} seed papers.`
      : null,
    rankScore: Number((work.rankScore ?? work.foundationalScore).toFixed(3)),
    scoreContributions: scoreContributions.map((item) => ({
      ...item,
      value: Number(item.value.toFixed(3))
    })),
    reasoning: {
      facet,
      score: Number(score.toFixed(3)),
      contributions: scoreContributions.map((item) => ({
        ...item,
        value: Number(item.value.toFixed(3))
      }))
    }
  };
}

async function enrichWithCitationHistory(
  papers: PaperRecommendation[],
  requestBudget: RequestBudget,
  citationHistoryFetcher: (workIds: string[]) => Promise<Map<string, CitationHistoryResult>>
): Promise<PaperRecommendation[]> {
  if (!papers.length) {
    return papers;
  }

  const missingHistoryPapers = papers.filter((paper) => paper.citationHistoryStatus === "unavailable");
  const fallbackTargets = missingHistoryPapers.slice(0, requestBudget.remaining());
  const histories = fallbackTargets.length && requestBudget.tryUse(fallbackTargets.length)
    ? await citationHistoryFetcher(fallbackTargets.map((paper) => paper.id))
    : new Map<string, CitationHistoryResult>();
  return papers.map((paper) => {
    const result = histories.get(paper.id);
    if (!result) {
      return paper;
    }
    return {
      ...paper,
      citationHistory: result.history,
      citationHistoryStatus: result.status,
      citationHistorySource: result.source,
      citationHistoryNote: result.note
    };
  });
}

function normalizeAuthors(authorships: OpenAlexWork["authorships"]): AuthorSummary[] {
  return (authorships ?? [])
    .map((authorship) => ({
      id: authorship.author?.id ?? "",
      name: authorship.author?.display_name ?? ""
    }))
    .filter((author) => author.id && author.name);
}

function bestClusterLabel(work: NormalizedWork): { id: string; label: string } {
  if (work.primaryTopic?.id && work.primaryTopic.display_name) {
    return { id: work.primaryTopic.id, label: work.primaryTopic.display_name };
  }
  const topic = work.topics.find((item) => item.id && item.display_name);
  if (topic?.id && topic.display_name) {
    return { id: topic.id, label: topic.display_name };
  }
  const keyword = work.keywords.find(Boolean);
  if (keyword) {
    return { id: `keyword:${normalizeTitle(keyword)}`, label: keyword };
  }
  const term = extractTitleTerms(work.title)[0] ?? "General topic";
  return { id: `term:${term}`, label: titleCase(term) };
}

function searchOrderRelevance(
  index: number,
  total: number,
  query: string,
  field: string,
  title: string,
  primaryTopic: OpenAlexTopic | null | undefined,
  topics: OpenAlexTopic[] | null | undefined,
  keywords: OpenAlexWork["keywords"],
  openAlexRelevance: number | null | undefined
): number {
  const searchPositionScore = total <= 1 ? 1 : 1 - index / Math.max(1, total - 1);
  const openAlexRelevanceScore = openAlexRelevance ? clamp01(openAlexRelevance / 100) : searchPositionScore;
  const queryTerms = tokenize(`${query} ${field}`);
  const haystack = [
    title,
    primaryTopic?.display_name ?? "",
    ...(topics ?? []).map((topic) => topic.display_name ?? ""),
    ...(keywords ?? []).map((keyword) => keyword.display_name ?? "")
  ]
    .join(" ")
    .toLowerCase();
  const matchedTerms = queryTerms.filter((term) => haystack.includes(term)).length;
  const textMatchScore = queryTerms.length ? matchedTerms / queryTerms.length : 0;
  return clamp01(0.45 * openAlexRelevanceScore + 0.25 * searchPositionScore + 0.3 * textMatchScore);
}

export function reconstructAbstract(invertedIndex: OpenAlexWork["abstract_inverted_index"]): string | null {
  if (!invertedIndex) {
    return null;
  }

  const positionedWords: Array<{ word: string; position: number }> = [];
  Object.entries(invertedIndex).forEach(([word, positions]) => {
    positions.forEach((position) => positionedWords.push({ word, position }));
  });

  const abstract = positionedWords
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.word)
    .join(" ")
    .trim();

  return abstract || null;
}

export function buildCompactText(
  title: string,
  abstractText: string | null,
  primaryTopic: OpenAlexTopic | null | undefined,
  topics: OpenAlexTopic[] | null | undefined,
  keywords: OpenAlexWork["keywords"]
): string {
  const topicText = [primaryTopic?.display_name, ...(topics ?? []).map((topic) => topic.display_name)].filter(Boolean).join("; ");
  const keywordText = (keywords ?? []).map((keyword) => keyword.display_name).filter(Boolean).join("; ");
  return [
    `Title: ${title}`,
    abstractText ? `Abstract: ${abstractText}` : null,
    topicText ? `Topics: ${topicText}` : null,
    keywordText ? `Keywords: ${keywordText}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function buildIdeaReasonCodes(supportingWorks: NormalizedWork[]): string[] {
  const codes = ["cluster-has-relevant-papers", "recent-influence-evidence", "evidence-backed-suggestion"];
  if (supportingWorks.some((work) => work.semanticRelevanceScore !== null && work.semanticRelevanceScore >= 0.72)) {
    codes.push("high-semantic-query-match");
  }
  if (supportingWorks.filter((work) => work.embeddingModel).length >= 3) {
    codes.push("semantic-cluster-match");
  }
  return codes;
}

function requiredBackgroundFor(goal: ResearchMapRequest["goal"], label: string): string[] {
  const base = ["paper reading", "basic statistics", label.toLowerCase()];
  if (goal === "build-project") {
    return [...base, "implementation skills", "evaluation design"];
  }
  if (goal === "publish") {
    return [...base, "related-work synthesis", "experiment design"];
  }
  if (goal === "find-researchers") {
    return [...base, "author and citation tracing"];
  }
  return base;
}

function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) {
    return null;
  }
  return doi.toLowerCase().replace("https://doi.org/", "").trim();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceQualityScore(type: string | null | undefined): number {
  if (!type) {
    return 0.5;
  }
  if (["article", "review", "proceedings-article"].includes(type)) {
    return 1;
  }
  if (["preprint", "book-chapter"].includes(type)) {
    return 0.75;
  }
  return 0.55;
}

function percentileValues(values: number[]): number[] {
  return values.map((value) => localPercentile(value, values));
}

function localPercentile(value: number, values: number[]): number {
  if (values.length <= 1) {
    return 1;
  }
  const lowerOrEqual = values.filter((candidate) => candidate <= value).length;
  return clamp01((lowerOrEqual - 1) / (values.length - 1));
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildQueryContext(request: ResearchMapRequest, clusters: TopicCluster[]): string[] {
  return uniqueTokens(tokenize([request.topic, request.field ?? "mechanical engineering", ...clusters.slice(0, 6).map((cluster) => cluster.label)].join(" ")));
}

function topicOverlap(work: OpenAlexWork, contextTokens: Set<string>): number {
  const topicTokens = uniqueTokens(
    [
      work.primary_topic?.id ?? "",
      work.primary_topic?.display_name ?? "",
      ...(work.topics ?? []).flatMap((topic) => [topic.id ?? "", topic.display_name ?? ""])
    ].flatMap(tokenize)
  );
  if (!topicTokens.length || !contextTokens.size) {
    return 0;
  }
  const matches = topicTokens.filter((token) => contextTokens.has(token)).length;
  return clamp01(matches / topicTokens.length);
}

function keywordOverlap(work: OpenAlexWork, contextTokens: string[]): number {
  const keywordTokens = uniqueTokens((work.keywords ?? []).flatMap((keyword) => tokenize(keyword.display_name ?? "")));
  if (!keywordTokens.length || !contextTokens.length) {
    return 0;
  }
  const context = new Set(contextTokens);
  const matches = keywordTokens.filter((token) => context.has(token)).length;
  return clamp01(matches / keywordTokens.length);
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) {
    return 0;
  }
  const intersection = Array.from(left).filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return clamp01(intersection / union);
}

function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function tokenize(text: string): string[] {
  return normalizeTitle(text)
    .split(" ")
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

function extractTitleTerms(title: string): string[] {
  return tokenize(title).slice(0, 3);
}

function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
