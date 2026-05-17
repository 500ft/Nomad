"use client";

import { FormEvent, useState } from "react";

import { visibleCitationHistory } from "@/lib/citation-history-view";
import type { ResearchMapResponse } from "@/lib/types";

const currentYear = new Date().getFullYear();

export default function Home() {
  const [topic, setTopic] = useState("machine learning for HVAC CFD");
  const [field, setField] = useState("mechanical engineering");
  const [experienceLevel, setExperienceLevel] = useState("beginner");
  const [goal, setGoal] = useState("build-project");
  const [fromYear, setFromYear] = useState(2020);
  const [toYear, setToYear] = useState(currentYear);
  const [result, setResult] = useState<ResearchMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);

    const response = await fetch("/api/research-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, field, experienceLevel, goal, fromYear, toYear })
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Could not generate the research map.");
      setIsLoading(false);
      return;
    }

    setResult(payload);
    setIsLoading(false);
  }

  return (
    <main>
      <section className="hero">
        <div className="heroText">
          <p className="eyebrow">Nomad</p>
          <h1>Build a research starting map for an engineering topic</h1>
          <p className="lede">
            Enter an engineering topic. Nomad returns what to read first, what has recent influence, who is active, what subtopics matter, and what project ideas are worth exploring.
          </p>
          <div className="focusGuide">
            <h3>Better topics make better maps.</h3>
            <p>A cluster is a group of papers that appear to share a topic, method, keyword, or OpenAlex topic label.</p>
            <p>Median relevance is the middle relevance score across usable papers. Higher usually means returned papers are closer to your topic. Lower usually means the map is broader or noisier.</p>
            <p>For stronger results, include a method, application, system, or measurable outcome.</p>
          </div>
        </div>
        <form className="searchPanel" onSubmit={onSubmit}>
          <label>
            Topic
            <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="battery thermal management" />
          </label>
          <label>
            Field
            <input value={field} onChange={(event) => setField(event.target.value)} placeholder="mechanical engineering" />
            <span className="fieldNote">Field is used as ranking context, not a strict database filter.</span>
          </label>
          <div className="formGrid">
            <label>
              Experience
              <select value={experienceLevel} onChange={(event) => setExperienceLevel(event.target.value)}>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="technical">Technical</option>
              </select>
            </label>
            <label>
              Goal
              <select value={goal} onChange={(event) => setGoal(event.target.value)}>
                <option value="read">Read</option>
                <option value="publish">Publish</option>
                <option value="build-project">Build project</option>
                <option value="find-researchers">Find researchers</option>
              </select>
            </label>
          </div>
          <div className="formGrid">
            <label>
              From
              <input type="number" value={fromYear} min={1900} max={currentYear} onChange={(event) => setFromYear(Number(event.target.value))} />
            </label>
            <label>
              To
              <input type="number" value={toYear} min={1900} max={currentYear} onChange={(event) => setToYear(Number(event.target.value))} />
            </label>
          </div>
          <button type="submit" disabled={isLoading}>{isLoading ? "Generating..." : "Generate research map"}</button>
          {error ? <p className="error">{error}</p> : null}
        </form>
      </section>

      {result ? <ResearchMap result={result} /> : null}
    </main>
  );
}

function ResearchMap({ result }: { result: ResearchMapResponse }) {
  return (
    <section className="results">
      <div className="summaryBand">
        <div>
          <p className="eyebrow">Research Starting Map</p>
          <h2>{result.query.topic}</h2>
          <p>
            Field context: <strong>{result.query.field}</strong> | Confidence: <strong>{result.confidence}</strong> | Usable works: <strong>{result.dataQuality.usableWorks}</strong> | Metrics: <strong>{result.metricsVersion}</strong>
          </p>
        </div>
        <div className="qualityBox">
          <span>{result.dataQuality.totalWorksFetched} fetched</span>
          <span>{result.dataQuality.deduplicatedWorks} deduped</span>
          <span>{result.dataQuality.excludedRetractedWorks} retracted excluded</span>
          <span>{result.dataQuality.worksWithAbstract} with abstracts</span>
          <span>semantic {result.semanticSignals.enabled ? "on" : "fallback"}</span>
        </div>
      </div>

      {result.warnings.length ? (
        <div className="warnings">
          {result.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      <div className="queryFocusCard">
        <div>
          <p className="eyebrow">Query Focus</p>
          <h3>{result.queryFocus.label}</h3>
          <p>{result.queryFocus.reason}</p>
        </div>
        <div className="focusMetrics">
          <span>median relevance {result.queryFocus.medianRelevance.toFixed(2)}</span>
          <span>{result.queryFocus.clusterCount} clusters</span>
          <span>{result.queryFocus.weakClusterCount} weak clusters</span>
          <span>{(result.queryFocus.topClusterShare * 100).toFixed(0)}% top cluster share</span>
        </div>
        <div>
          <h4>Try a more specific query</h4>
          <p>These suggestions add one missing constraint: method, application, system, or measurable outcome.</p>
          <ul>
            {result.queryFocus.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </div>
      </div>

      <ResultSection title="Start Here" subtitle="Foundational papers ranked by normalized citation signal, relevance, and source quality.">
        {result.foundationalPapers.map((paper) => <PaperCard key={paper.id} paper={paper} />)}
      </ResultSection>

      <ResultSection title="Watch Now" subtitle="Top 5 recent-influence papers with citation-history evidence when available.">
        {result.recentInfluencePapers.map((paper) => <PaperCard key={paper.id} paper={paper} showCitationHistory />)}
      </ResultSection>

      <ResultSection title="People of Interest" subtitle="Authors ranked by OpenAlex ID, repeated relevance, recent work, and recent-influence involvement.">
        {result.people.map((person) => (
          <article className="item" key={person.id}>
            <h3>{person.name}</h3>
            <p>Score {person.score.toFixed(2)} | {person.relevantPaperCount} relevant works | {person.recentPaperCount} recent works</p>
            <a href={person.id} target="_blank" rel="noreferrer">OpenAlex profile</a>
          </article>
        ))}
      </ResultSection>

      <ResultSection title="Field Map" subtitle="V1 clusters use OpenAlex topics and keywords, with title terms as fallback.">
        {result.clusters.map((cluster) => (
          <article className="item" key={cluster.id}>
            <h3>{cluster.label}</h3>
            <p>Score {cluster.score.toFixed(2)} | {cluster.paperCount} papers | {(cluster.recentPaperShare * 100).toFixed(0)}% recent share</p>
          </article>
        ))}
      </ResultSection>

      <ResultSection title="Citation Signals" subtitle="Quantitative citation and paper-count signals. These are context signals, not predictions.">
        <article className="item">
          <h3>Usable works</h3>
          <p>{result.citationSignals.totalUsableWorks} works after filtering and deduplication.</p>
        </article>
        <article className="item">
          <h3>Median citations per year</h3>
          <p>{result.citationSignals.medianCitationsPerYear.toFixed(2)} citations/year across usable works.</p>
        </article>
        <article className="item">
          <h3>Largest cluster</h3>
          <p>{result.citationSignals.topClusterByPaperCount ?? "No cluster available"}</p>
        </article>
        <article className="item">
          <h3>Recent influence cluster</h3>
          <p>{result.citationSignals.topClusterByRecentInfluence ?? "No cluster available"}</p>
        </article>
        <article className="item">
          <h3>Recent paper share</h3>
          <p>{(result.citationSignals.recentPaperShare * 100).toFixed(0)}% of usable works are recent.</p>
        </article>
        <article className="item">
          <h3>Signal confidence</h3>
          <p>{result.citationSignals.confidence}</p>
        </article>
        <article className="item">
          <h3>Semantic ranking</h3>
          <p>
            {result.semanticSignals.enabled
              ? `${result.semanticSignals.embeddedPaperCount} papers embedded with ${result.semanticSignals.model}.`
              : "Unavailable; using keyword and citation scoring only."}
          </p>
        </article>
        <article className="item">
          <h3>Citation network</h3>
          <p>
            Seed papers: {result.citationNetworkSignals.seedPaperCount} | With references: {result.citationNetworkSignals.seedPapersWithReferences}
          </p>
          <p>
            Shared references: {result.citationNetworkSignals.sharedReferenceCount} | Fetched: {result.citationNetworkSignals.fetchedReferenceCount}
          </p>
          <p>
            Request budget: {result.citationNetworkSignals.requestBudgetUsed}/{result.citationNetworkSignals.requestBudgetMax}
          </p>
          <p className="smallText">{result.citationNetworkSignals.limitations[0]}</p>
        </article>
        <article className="item directionSummary">
          <h3>Research Direction Summary</h3>
          <p>{result.researchDirectionSummary.briefSummary}</p>
          <p className="smallText">{result.researchDirectionSummary.limitations[0]}</p>
        </article>
        <article className="item directionSummary">
          <h3>Stronger recent activity in this result set</h3>
          {result.researchDirectionSummary.strongerRecentActivity.length ? (
            result.researchDirectionSummary.strongerRecentActivity.map((signal) => <DirectionSignal key={signal.label} signal={signal} />)
          ) : (
            <p>No cluster met the stronger recent-activity threshold.</p>
          )}
        </article>
        <article className="item directionSummary">
          <h3>Weaker recent-paper signal in this result set</h3>
          {result.researchDirectionSummary.weakerRecentPaperSignal.length ? (
            result.researchDirectionSummary.weakerRecentPaperSignal.map((signal) => <DirectionSignal key={signal.label} signal={signal} />)
          ) : (
            <p>No cluster met the weaker recent-paper signal threshold.</p>
          )}
        </article>
      </ResultSection>

      <ResultSection title="Project Ideas" subtitle="Niche, evidence-backed project directions generated from supporting papers and clusters.">
        {result.projectIdeas.map((idea) => (
          <article className="item" key={idea.title}>
            <div className="itemHeader">
              <h3>{idea.title}</h3>
              <span>{idea.confidence}</span>
            </div>
            <p className="smallText">
              {[idea.projectType, ...(idea.distinctivenessSignals ?? []).slice(0, 3)].filter(Boolean).join(" | ")}
            </p>
            <p>{idea.description}</p>
            <p><strong>Why now:</strong> {idea.whyNow}</p>
            <p><strong>First experiment:</strong> {idea.firstExperiment ?? idea.mvpVersion}</p>
            <p><strong>Evidence:</strong> {idea.supportingPaperIds.length} papers, {idea.supportingClusterIds.length} clusters</p>
            <p>
              <strong>Traceability:</strong> {idea.traceability.supportingReferenceIds.length} shared references | {idea.traceability.evidenceTypes.join(", ")}
            </p>
            <p className="smallText">{idea.traceability.evidenceNote}</p>
            <p className="smallText">{idea.traceability.limitations[0]}</p>
          </article>
        ))}
      </ResultSection>

    </section>
  );
}

function DirectionSignal({ signal }: { signal: ResearchMapResponse["researchDirectionSummary"]["strongerRecentActivity"][number] }) {
  return (
    <div className="signalBlock">
      <div className="itemHeader">
        <h4>{signal.label}</h4>
        <span>{signal.confidence}</span>
      </div>
      <p>{signal.reason}</p>
      <p className="smallText">
        momentum {signal.directionMomentumScore.toFixed(2)} | {signal.paperCount} papers | {(signal.recentPaperShare * 100).toFixed(0)}% recent
      </p>
    </div>
  );
}

function ResultSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="resultSection">
      <div className="sectionIntro">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="itemGrid">{children}</div>
    </section>
  );
}

function PaperCard({ paper, showCitationHistory = false }: { paper: ResearchMapResponse["foundationalPapers"][number]; showCitationHistory?: boolean }) {
  return (
    <article className="item">
      <div className="itemHeader">
        <h3>{paper.title}</h3>
        <span>{paper.score.toFixed(2)}</span>
      </div>
      <p>
        {paper.year} | {paper.citationCount} citations | {paper.citationsPerYear.toFixed(1)} citations/year
      </p>
      {showCitationHistory ? <CitationHistory paper={paper} /> : null}
      {paper.graphSupportNote ? <p className="smallText">{paper.graphSupportNote}</p> : null}
      <p>{paper.authors.map((author) => author.name).join(", ")}</p>
      <a href={paper.url} target="_blank" rel="noreferrer">OpenAlex record</a>
    </article>
  );
}

function CitationHistory({ paper }: { paper: ResearchMapResponse["recentInfluencePapers"][number] }) {
  if (paper.citationHistoryStatus !== "available" || !paper.citationHistory?.length) {
    return <p className="smallText">{paper.citationHistoryNote}</p>;
  }

  const visibleHistory = visibleCitationHistory(paper.citationHistory);
  if (!visibleHistory.length) {
    return <p className="smallText">No nonzero yearly citation counts available. Showing citations/year proxy instead.</p>;
  }

  const maxCount = Math.max(1, ...visibleHistory.map((item) => item.citationCount));

  return (
    <div className="citationHistory">
      <p className="smallText">
        {paper.citationHistorySource === "openalex-counts-by-year"
          ? "Recent yearly citations from OpenAlex. Years with zero citations are hidden."
          : "Yearly citing-work counts from OpenAlex grouped fallback."}
      </p>
      <div className="citationBars" aria-label="Recent yearly citations from OpenAlex">
        {visibleHistory.map((item) => (
          <div className="citationBarItem" key={item.year}>
            <div className="citationBarTrack">
              <div className="citationBarFill" style={{ height: `${Math.max(8, (item.citationCount / maxCount) * 100)}%` }} />
            </div>
            <span>{item.year}{item.isPartialYear ? "*" : ""}</span>
            <strong>{item.citationCount}</strong>
          </div>
        ))}
      </div>
      {visibleHistory.some((item) => item.isPartialYear) ? <p className="smallText">* Current year is partial.</p> : null}
    </div>
  );
}
