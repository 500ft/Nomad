"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { getCached, setCached } from "@/lib/derive/cache";
import { isLowRelevanceMap } from "@/lib/derive/explain";
import { deriveClusterTrends } from "@/lib/derive/trend";
import type { V2ResearchMapResponse } from "@/lib/quality/v2-types";
import type { ResearchMapResponse } from "@/lib/types";
import styles from "./explore.module.css";
import { ExampleTopics, type Example } from "./_components/ExampleTopics";
import { KnowledgeGraph } from "./_components/KnowledgeGraph";
import { MindMap } from "./_components/MindMap";
import { QualityReportPanel } from "./_components/QualityReportPanel";
import { ReadingRoadmap } from "./_components/ReadingRoadmap";
import { TrendRadar } from "./_components/TrendRadar";

const currentYear = new Date().getFullYear();

type Tab = "roadmap" | "trend" | "graph" | "mindmap";
type Engine = "v1" | "v2";

type AnyMap = ResearchMapResponse | V2ResearchMapResponse;

export default function ExplorePage() {
  const [topic, setTopic] = useState("battery thermal management");
  const [field, setField] = useState("mechanical engineering");
  const [experienceLevel, setExperienceLevel] = useState<Example["experienceLevel"]>("beginner");
  const [goal, setGoal] = useState<Example["goal"]>("read");
  const [fromYear, setFromYear] = useState(2020);
  const [toYear, setToYear] = useState(currentYear);
  const [engine, setEngine] = useState<Engine>("v2");
  const [result, setResult] = useState<AnyMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [tab, setTab] = useState<Tab>("roadmap");

  const trends = useMemo(
    () => (result ? deriveClusterTrends(result as ResearchMapResponse) : []),
    [result]
  );
  const showTrustBanner = result ? isLowRelevanceMap(result as ResearchMapResponse) : false;
  const v2Report = result && "qualityReport" in result ? result.qualityReport : null;

  async function generate(query: { topic: string; field?: string; experienceLevel: string; goal: string; fromYear: number; toYear: number }) {
    setIsLoading(true);
    setError(null);
    setFromCache(false);

    const cacheKey = {
      topic: query.topic,
      field: query.field ?? field,
      experienceLevel: query.experienceLevel,
      goal: query.goal,
      fromYear: query.fromYear,
      toYear: query.toYear,
      engine
    };
    const cached = getCached(cacheKey);
    if (cached) {
      setResult(cached);
      setFromCache(true);
      setIsLoading(false);
      return;
    }

    const path = engine === "v2" ? "/api/research-map/v2" : "/api/research-map";

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query)
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Could not generate the research map.");
        return;
      }
      setResult(payload);
      setCached(cacheKey, payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIsLoading(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    generate({ topic, field, experienceLevel, goal, fromYear, toYear });
  }

  function pickExample(ex: Example) {
    setTopic(ex.topic);
    setExperienceLevel(ex.experienceLevel);
    setGoal(ex.goal);
    setFromYear(ex.fromYear);
    setToYear(ex.toYear);
    generate({ ...ex, field });
  }

  // Scroll to results after first load
  useEffect(() => {
    if (result) {
      document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Nomad / Explore</p>
          <h1>Reading Roadmap, Trend Radar, Visual Maps</h1>
          <p className={styles.lede}>
            Tells a beginner what to read first, why each paper matters, and where the field is moving using Nomad&apos;s OpenAlex-backed evidence.
          </p>
        </div>
        <Link className={styles.classicLink} href="/">
          ← Classic view
        </Link>
      </header>

      <ExampleTopics onPick={pickExample} />

      <div className={styles.engineToggle}>
        <span className={styles.engineLabel}>Engine:</span>
        <div className={styles.engineButtons}>
          <button
            type="button"
            className={`${styles.engineButton} ${engine === "v1" ? styles.engineButtonActive : ""}`}
            onClick={() => setEngine("v1")}
            disabled={isLoading}
          >
            v1 — classic
          </button>
          <button
            type="button"
            className={`${styles.engineButton} ${engine === "v2" ? styles.engineButtonActive : ""}`}
            onClick={() => setEngine("v2")}
            disabled={isLoading}
          >
            v2 — quality (relevance filter + cluster split)
          </button>
        </div>
      </div>

      <form className={styles.searchPanel} onSubmit={onSubmit}>
        <label>
          Topic
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="battery thermal management" />
        </label>
        <label>
          Field
          <input value={field} onChange={(e) => setField(e.target.value)} placeholder="mechanical engineering" />
        </label>
        <div className={styles.formGrid}>
          <label>
            Experience
            <select value={experienceLevel} onChange={(e) => setExperienceLevel(e.target.value as Example["experienceLevel"])}>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="technical">Technical</option>
            </select>
          </label>
          <label>
            Goal
            <select value={goal} onChange={(e) => setGoal(e.target.value as Example["goal"])}>
              <option value="read">Read</option>
              <option value="publish">Publish</option>
              <option value="build-project">Build project</option>
              <option value="find-researchers">Find researchers</option>
            </select>
          </label>
        </div>
        <div className={styles.formGrid}>
          <label>
            From
            <input type="number" value={fromYear} min={1900} max={currentYear} onChange={(e) => setFromYear(Number(e.target.value))} />
          </label>
          <label>
            To
            <input type="number" value={toYear} min={1900} max={currentYear} onChange={(e) => setToYear(Number(e.target.value))} />
          </label>
        </div>
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Generating..." : "Generate research map"}
        </button>
        {error ? <p className={styles.error}>{error}</p> : null}
      </form>

      {result ? (
        <section className={styles.results} id="results">
          <div className={styles.summaryBand}>
            <div>
              <p className={styles.eyebrow}>{result.query.topic}</p>
              <p>
                Engine: <strong>{result.metricsVersion}</strong> | Overall confidence: <strong>{result.confidence}</strong> | Usable works:{" "}
                <strong>{result.dataQuality.usableWorks}</strong> | Clusters: <strong>{result.clusters.length}</strong>
                {fromCache ? <span className={styles.cacheTag}> · cached</span> : null}
              </p>
            </div>
            <div className={styles.qualityBox}>
              <span>{result.foundationalPapers.length} foundational</span>
              <span>{result.recentInfluencePapers.length} rising</span>
              <span>{result.people.length} authors</span>
            </div>
          </div>

          {showTrustBanner ? (
            <div className={styles.trustBanner}>
              <strong>Trust check:</strong> This topic returned weakly relevant results. Some foundational picks may be off-topic — read the “Why this paper?” chips before relying on them, and consider tightening the query.
            </div>
          ) : null}

          {v2Report ? <QualityReportPanel report={v2Report} /> : null}

          {result.warnings.length ? (
            <div className={styles.warnings}>
              {result.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          ) : null}

          <div className={styles.tabs}>
            <TabButton active={tab === "roadmap"} onClick={() => setTab("roadmap")}>
              Reading Roadmap
            </TabButton>
            <TabButton active={tab === "trend"} onClick={() => setTab("trend")}>
              Trend Radar
            </TabButton>
            <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>
              Knowledge Graph
            </TabButton>
            <TabButton active={tab === "mindmap"} onClick={() => setTab("mindmap")}>
              Mind Map
            </TabButton>
          </div>

          <div className={styles.tabPanel}>
            {tab === "roadmap" ? <ReadingRoadmap map={result as ResearchMapResponse} /> : null}
            {tab === "trend" ? <TrendRadar trends={trends} /> : null}
            {tab === "graph" ? <KnowledgeGraph map={result as ResearchMapResponse} /> : null}
            {tab === "mindmap" ? <MindMap map={result as ResearchMapResponse} /> : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`${styles.tabButton} ${active ? styles.tabButtonActive : ""}`}>
      {children}
    </button>
  );
}
