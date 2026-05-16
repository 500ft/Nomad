export type Confidence = "strong" | "moderate" | "sparse";

export type ExperienceLevel = "beginner" | "intermediate" | "technical";

export type ResearchGoal = "read" | "publish" | "build-project" | "find-researchers";

export type ResearchMapRequest = {
  topic: string;
  field?: string;
  experienceLevel: ExperienceLevel;
  goal: ResearchGoal;
  fromYear: number;
  toYear: number;
};

export type PaperRecommendation = {
  id: string;
  title: string;
  year: number;
  url: string;
  doi: string | null;
  type: string | null;
  citationCount: number;
  citationsPerYear: number;
  relevanceScore: number;
  semanticRelevanceScore: number | null;
  score: number;
  reasonCodes: string[];
  authors: AuthorSummary[];
  citationHistory: CitationYear[] | null;
  citationHistoryStatus: CitationHistoryStatus;
  citationHistorySource: CitationHistorySource | null;
  citationHistoryNote: string;
  graphSupportScore: number;
  graphSupportNote: string | null;
};

export type CitationYear = {
  year: number;
  citationCount: number;
  isPartialYear: boolean;
};

export type CitationHistoryStatus = "available" | "unavailable";

export type CitationHistorySource = "openalex-counts-by-year" | "openalex-cited-by-grouped-fallback";

export type CitationHistoryResult = {
  status: CitationHistoryStatus;
  history: CitationYear[] | null;
  source: CitationHistorySource | null;
  note: string;
};

export type AuthorSummary = {
  id: string;
  name: string;
};

export type ResearcherRecommendation = {
  id: string;
  name: string;
  score: number;
  relevantPaperCount: number;
  recentPaperCount: number;
  risingPaperInvolvementCount: number;
  paperIds: string[];
};

export type TopicCluster = {
  id: string;
  label: string;
  score: number;
  paperCount: number;
  recentPaperShare: number;
  averageRelevanceScore: number;
  averageRecentInfluenceScore: number;
  paperIds: string[];
};

export type ProjectIdea = {
  title: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  requiredBackground: string[];
  supportingPaperIds: string[];
  supportingClusterIds: string[];
  reasonCodes: string[];
  whyNow: string;
  mvpVersion: string;
  confidence: Confidence;
  traceability: ProjectTraceability;
};

export type EvidenceType =
  | "recent-paper"
  | "shared-reference"
  | "cluster-signal"
  | "citation-history"
  | "high-normalized-citation"
  | "author-activity";

export type ProjectTraceability = {
  supportingPaperIds: string[];
  supportingClusterIds: string[];
  supportingReferenceIds: string[];
  evidenceTypes: EvidenceType[];
  evidenceNote: string;
  limitations: string[];
};

export type EvidenceItem = {
  id: string;
  kind: "paper" | "cluster" | "author";
  label: string;
  metric: string;
  sourceIds: string[];
};

export type DataQuality = {
  usableWorks: number;
  totalWorksFetched: number;
  worksWithAbstract: number;
  worksWithDoi: number;
  deduplicatedWorks: number;
  excludedRetractedWorks: number;
};

export type CitationSignals = {
  totalUsableWorks: number;
  medianCitationsPerYear: number;
  topClusterByPaperCount: string | null;
  topClusterByRecentInfluence: string | null;
  recentPaperShare: number;
  confidence: Confidence;
};

export type SharedReferenceEvidence = {
  id: string;
  title: string;
  publicationYear: number | null;
  citedByCount: number | null;
  citationNormalizedPercentile: number | null;
  fwci: number | null;
  referencedBySeedPaperIds: string[];
  referenceFrequency: number;
  relevanceGatePassed: boolean;
  evidenceTypes: Array<"shared-reference" | "topic-overlap" | "citation-percentile" | "source-quality">;
};

export type CitationNetworkSignals = {
  seedPaperIds: string[];
  seedPaperCount: number;
  seedPapersWithReferences: number;
  fetchedReferenceCount: number;
  sharedReferenceCount: number;
  graphCoverageRatio: number;
  requestBudgetUsed: number;
  requestBudgetMax: 7;
  topSharedReferences: SharedReferenceEvidence[];
  limitations: string[];
};

export type QueryFocusLabel = "focused" | "moderate" | "broad" | "sparse";

export type QueryFocus = {
  label: QueryFocusLabel;
  medianRelevance: number;
  clusterCount: number;
  weakClusterCount: number;
  weakClusterShare: number;
  topClusterShare: number;
  usableWorks: number;
  reason: string;
  suggestions: string[];
};

export type SummarySignal = {
  label: string;
  reason: string;
  paperCount: number;
  recentPaperShare: number;
  averageRecentInfluenceScore: number;
  averageRelevanceScore: number;
  directionMomentumScore: number;
  supportingPaperIds: string[];
  confidence: Confidence;
};

export type ResearchDirectionSummary = {
  strongerRecentActivity: SummarySignal[];
  weakerRecentPaperSignal: SummarySignal[];
  briefSummary: string;
  limitations: string[];
};

export type SemanticSignals = {
  enabled: boolean;
  model: string | null;
  embeddedPaperCount: number;
  failedPaperCount: number;
};

export type ResearchMapResponse = {
  query: ResearchMapRequest;
  confidence: Confidence;
  foundationalPapers: PaperRecommendation[];
  recentInfluencePapers: PaperRecommendation[];
  people: ResearcherRecommendation[];
  clusters: TopicCluster[];
  queryFocus: QueryFocus;
  citationSignals: CitationSignals;
  citationNetworkSignals: CitationNetworkSignals;
  researchDirectionSummary: ResearchDirectionSummary;
  semanticSignals: SemanticSignals;
  projectIdeas: ProjectIdea[];
  evidence: EvidenceItem[];
  warnings: string[];
  dataQuality: DataQuality;
  metricsVersion: "v1";
  generatedAt: string;
};

export type OpenAlexWork = {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  relevance_score?: number | null;
  cited_by_count?: number | null;
  citation_normalized_percentile?: {
    value?: number | null;
    is_in_top_1_percent?: boolean | null;
    is_in_top_10_percent?: boolean | null;
  } | null;
  authorships?: Array<{
    author?: {
      id?: string | null;
      display_name?: string | null;
    } | null;
  }> | null;
  primary_topic?: OpenAlexTopic | null;
  topics?: OpenAlexTopic[] | null;
  keywords?: Array<{
    id?: string | null;
    display_name?: string | null;
  }> | null;
  type?: string | null;
  is_retracted?: boolean | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  counts_by_year?: OpenAlexCountByYear[] | null;
  referenced_works?: string[] | null;
  referenced_works_count?: number | null;
  fwci?: number | null;
  cited_by_api_url?: string | null;
};

export type OpenAlexCountByYear = {
  year?: number | null;
  cited_by_count?: number | null;
};

export type OpenAlexTopic = {
  id?: string | null;
  display_name?: string | null;
};

export type NormalizedWork = {
  id: string;
  doi: string | null;
  title: string;
  normalizedTitle: string;
  year: number;
  publicationDate: string | null;
  citationCount: number;
  citationPercentileValue: number | null;
  authors: AuthorSummary[];
  primaryTopic: OpenAlexTopic | null;
  topics: OpenAlexTopic[];
  keywords: string[];
  abstractText: string | null;
  compactText: string;
  type: string | null;
  isRetracted: boolean;
  hasAbstract: boolean;
  countsByYear: OpenAlexCountByYear[];
  referencedWorks: string[];
  referencedWorksCount: number | null;
  fwci: number | null;
  citedByApiUrl: string | null;
  url: string;
  relevanceScore: number;
  keywordRelevanceScore: number;
  semanticRelevanceScore: number | null;
  finalRelevanceScore: number;
  embeddingModel: string | null;
  logCitationScore: number;
  citationPercentileScore: number;
  citationsPerYearScore: number;
  recencyScore: number;
  sourceQualityScore: number;
  graphSupportScore: number;
  graphSupportSeedCount: number;
  graphSupportSeedTotal: number;
  foundationalScore: number;
  recentInfluenceScore: number;
  citationsPerYear: number;
};
