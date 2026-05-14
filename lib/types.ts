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
  citationHistoryNote: string;
};

export type CitationYear = {
  year: number;
  citationCount: number;
  isPartialYear: boolean;
};

export type CitationHistoryStatus = "available" | "unavailable";

export type CitationHistoryResult = {
  status: CitationHistoryStatus;
  history: CitationYear[] | null;
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
  citationSignals: CitationSignals;
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
  citationPercentile: number | null;
  authors: AuthorSummary[];
  primaryTopic: OpenAlexTopic | null;
  topics: OpenAlexTopic[];
  keywords: string[];
  abstractText: string | null;
  compactText: string;
  type: string | null;
  isRetracted: boolean;
  hasAbstract: boolean;
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
  foundationalScore: number;
  recentInfluenceScore: number;
  citationsPerYear: number;
};
