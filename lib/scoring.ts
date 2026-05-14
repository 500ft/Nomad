import type {
  AuthorSummary,
  CitationHistoryResult,
  Confidence,
  DataQuality,
  EvidenceItem,
  NormalizedWork,
  OpenAlexTopic,
  OpenAlexWork,
  PaperRecommendation,
  ProjectIdea,
  ResearchMapRequest,
  ResearchMapResponse,
  ResearchDirectionSummary,
  ResearcherRecommendation,
  SummarySignal,
  TopicCluster
} from "./types";
import { applySemanticRelevance, blendRelevance, buildQueryText } from "./embeddings";
import { fetchCitationHistoryForWorks } from "./openalex";

const FOUNDATIONAL_LIMIT = 5;
const WATCH_NOW_LIMIT = 5;
const PEOPLE_LIMIT = 5;
const CLUSTER_LIMIT = 6;

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

export async function buildResearchMap(
  request: ResearchMapRequest,
  works: OpenAlexWork[],
  citationHistoryFetcher = fetchCitationHistoryForWorks
): Promise<ResearchMapResponse> {
  const normalizedRequest = normalizeRequest(request);
  const normalized = normalizeWorks(normalizedRequest, works);
  const initiallyScored = scoreWorks(normalizedRequest, normalized.works);
  const semantic = await applySemanticRelevance(initiallyScored, buildQueryText(normalizedRequest.topic, normalizedRequest.field, normalizedRequest.goal));
  const scored = scoreWorks(normalizedRequest, semantic.works);
  const clusters = buildClusters(scored);
  const foundationalPapers = scored
    .slice()
    .sort((a, b) => b.foundationalScore - a.foundationalScore)
    .slice(0, FOUNDATIONAL_LIMIT)
    .map((work) => toPaperRecommendation(work, work.foundationalScore, ["high-citation-signal", "topic-relevant"]));
  const recentInfluencePapersWithoutHistory = scored
    .slice()
    .sort((a, b) => b.recentInfluenceScore - a.recentInfluenceScore)
    .slice(0, WATCH_NOW_LIMIT)
    .map((work) => toPaperRecommendation(work, work.recentInfluenceScore, ["recent-influence-proxy", "topic-relevant"]));
  const recentInfluencePapers = await enrichWithCitationHistory(recentInfluencePapersWithoutHistory, citationHistoryFetcher);
  const people = buildPeople(scored, recentInfluencePapers.map((paper) => paper.id));
  const projectIdeas = buildProjectIdeas(normalizedRequest, clusters, scored);
  const confidence = computeMapConfidence(scored.length, median(scored.map((work) => work.relevanceScore)));
  const dataQuality = buildDataQuality(works, normalized.works, normalized.dedupedCount, normalized.excludedRetractedCount);
  const warnings = buildWarnings(dataQuality, confidence, median(scored.map((work) => work.relevanceScore)), semantic.signals.enabled);
  if (recentInfluencePapers.length && recentInfluencePapers.every((paper) => paper.citationHistoryStatus === "unavailable")) {
    warnings.push("Citation history unavailable; using citations/year proxy for Watch Now.");
  }
  const evidence = buildEvidence(foundationalPapers, recentInfluencePapers, people, clusters);
  const citationSignals = buildCitationSignals(scored, clusters, confidence);
  const researchDirectionSummary = buildResearchDirectionSummary(clusters);

  return {
    query: normalizedRequest,
    confidence,
    foundationalPapers,
    recentInfluencePapers,
    people,
    clusters: clusters.slice(0, CLUSTER_LIMIT),
    citationSignals,
    researchDirectionSummary,
    semanticSignals: semantic.signals,
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
      citationPercentile: work.citation_normalized_percentile?.value ?? null,
      authors: normalizeAuthors(work.authorships),
      primaryTopic: work.primary_topic ?? null,
      topics: work.topics ?? [],
      keywords: (work.keywords ?? []).map((keyword) => keyword.display_name ?? "").filter(Boolean),
      abstractText,
      compactText: buildCompactText(title, abstractText, work.primary_topic, work.topics, work.keywords),
      type: work.type ?? null,
      isRetracted: Boolean(work.is_retracted),
      hasAbstract: Boolean(work.abstract_inverted_index),
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
      logCitationScore: 0,
      citationPercentileScore: 0,
      citationsPerYearScore: 0,
      recencyScore: 0,
      sourceQualityScore: sourceQualityScore(work.type),
      foundationalScore: 0,
      recentInfluenceScore: 0,
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

export function scoreWorks(request: ResearchMapRequest, works: NormalizedWork[]): NormalizedWork[] {
  const currentYear = new Date().getFullYear();
  const logCitations = works.map((work) => Math.log1p(work.citationCount));
  const citationsPerYear = works.map((work) => work.citationCount / Math.max(1, currentYear - work.year + 1));
  const localCitationPercentiles = percentileValues(works.map((work) => work.citationCount));

  return works.map((work, index) => {
    const ageWindow = Math.max(1, request.toYear - request.fromYear);
    const normalizedAge = Math.min(1, Math.max(0, (request.toYear - work.year) / ageWindow));
    const citationPercentileScore = clamp01(work.citationPercentile ?? localCitationPercentiles[index] ?? 0);
    const finalRelevanceScore = blendRelevance(work.keywordRelevanceScore || work.relevanceScore, work.semanticRelevanceScore, citationPercentileScore);
    const scored = {
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
      0.25 * scored.citationPercentileScore +
      0.25 * scored.finalRelevanceScore +
      0.1 * scored.sourceQualityScore;
    scored.recentInfluenceScore =
      0.3 * scored.citationsPerYearScore +
      0.25 * scored.recencyScore +
      0.3 * scored.finalRelevanceScore +
      0.15 * scored.citationPercentileScore;
    return scored;
  });
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

export function buildProjectIdeas(request: ResearchMapRequest, clusters: TopicCluster[], works: NormalizedWork[]): ProjectIdea[] {
  return clusters.slice(0, 5).map((cluster) => {
    const supportingWorks = cluster.paperIds
      .map((paperId) => works.find((work) => work.id === paperId))
      .filter((work): work is NormalizedWork => Boolean(work))
      .slice(0, 6);
    const confidence = computeProjectConfidence(supportingWorks.length, [cluster.id]);
    const difficulty = request.experienceLevel === "beginner" ? "beginner" : request.experienceLevel === "technical" ? "advanced" : "intermediate";
    return {
      title: `Build a focused ${cluster.label.toLowerCase()} research map`,
      description: `Create a small project that compares methods, datasets, or evaluation gaps in ${cluster.label.toLowerCase()} using the strongest recent papers as evidence.`,
      difficulty,
      requiredBackground: requiredBackgroundFor(request.goal, cluster.label),
      supportingPaperIds: supportingWorks.map((work) => work.id),
      supportingClusterIds: [cluster.id],
      reasonCodes: buildIdeaReasonCodes(supportingWorks),
      whyNow: `Evidence suggests this is worth exploring because ${cluster.paperCount} relevant works appeared in the selected range and ${(cluster.recentPaperShare * 100).toFixed(0)}% are recent.`,
      mvpVersion: `Read the top ${Math.min(5, supportingWorks.length)} supporting papers, reproduce one core method or comparison, and write a short evidence-backed summary of what is still hard.`,
      confidence
    };
  });
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

function buildWarnings(dataQuality: DataQuality, confidence: Confidence, medianRelevance: number, semanticEnabled: boolean): string[] {
  const warnings: string[] = [];
  if (!semanticEnabled) {
    warnings.push("Semantic ranking unavailable; using keyword and citation scoring only.");
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
  if (medianRelevance < 0.45) {
    warnings.push("Low median relevance: review the topic wording before relying on the map.");
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

function toPaperRecommendation(work: NormalizedWork, score: number, reasonCodes: string[]): PaperRecommendation {
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
    reasonCodes,
    authors: work.authors.slice(0, 5),
    citationHistory: null,
    citationHistoryStatus: "unavailable",
    citationHistoryNote: "Citation history unavailable. Showing citations/year proxy instead."
  };
}

async function enrichWithCitationHistory(
  papers: PaperRecommendation[],
  citationHistoryFetcher: (workIds: string[]) => Promise<Map<string, CitationHistoryResult>>
): Promise<PaperRecommendation[]> {
  if (!papers.length) {
    return papers;
  }

  const histories = await citationHistoryFetcher(papers.map((paper) => paper.id));
  return papers.map((paper) => {
    const result = histories.get(paper.id);
    if (!result) {
      return paper;
    }
    return {
      ...paper,
      citationHistory: result.history,
      citationHistoryStatus: result.status,
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
