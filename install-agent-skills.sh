#!/usr/bin/env bash
# install-agent-skills.sh
# Installs the three custom skills into ~/.agents/skills/ (single source of truth)
# and symlinks them into ~/.claude/skills/ and ~/.codex/skills/ so Claude Code
# and Codex stay in sync automatically. Re-runnable; existing real folders are
# backed up, never overwritten.

set -euo pipefail

AGENTS_DIR="$HOME/.agents/skills"
CLAUDE_DIR="$HOME/.claude/skills"
CODEX_DIR="$HOME/.codex/skills"
SKILLS=(research-analysis engineering-problem-solving project-builder)

mkdir -p "$AGENTS_DIR" "$CLAUDE_DIR" "$CODEX_DIR"

# ---------------------------------------------------------------- skill files
mkdir -p "$AGENTS_DIR/research-analysis"
cat > "$AGENTS_DIR/research-analysis/SKILL.md" <<'EOF'
---
name: research-analysis
description: Systematic analysis of research literature — triaging papers, judging relevance, ranking importance, grading evidence, and synthesizing findings with full traceability. Use this skill whenever the task involves academic papers, literature reviews, citation analysis, ranking or filtering search results from scholarly databases (OpenAlex, Semantic Scholar, arXiv, PubMed), evaluating evidence quality, building research maps, or deciding which papers/sources matter for a topic — even if the user just says "find papers on X", "what's the state of the art", or "is this source any good".
---

# Research Analysis

A doctrine for analyzing research literature so conclusions are evidence-backed, ranked honestly, and traceable to sources.

## The core separation: aboutness vs. importance

The single most common failure in literature analysis is letting *importance signals* (citations, venue prestige, author fame) answer a *relevance question* (is this paper about my topic?). A 10,000-citation paper that is tangential to the query is still tangential.

Always run two separate decisions:

1. **Eligibility gate (aboutness only).** Is the paper about the question? Inputs: title, abstract, keywords, topics. Forbidden inputs: citation counts, venue, recency, author reputation.
2. **Importance ranking (eligible papers only).** Among papers that passed the gate, which matter most? Now citations, citation velocity, venue, and network position are legitimate inputs.

Never blend the two into one score. A blended scalar lets fame buy relevance and makes every downstream conclusion suspect.

## Workflow

### 1. Define the question precisely
Write the research question as one sentence with the system, the method (if constrained), and the outcome of interest. A vague query produces a vague evidence set; diagnose query focus before trusting results.

### 2. Retrieve broadly, then gate
Cast a wide net (synonyms, adjacent terminology, both US/UK spellings). Then grade each candidate on an ordinal aboutness scale:

- **0 — off-topic:** exclude entirely; must not influence any downstream analysis
- **1 — tangential:** background only; never cite as primary support
- **2 — relevant:** addresses the question's domain directly
- **3 — core:** directly answers or tests the question

A paper with no abstract is *unverified*, not relevant — retain it but cap it below grade-2 papers and flag it. Absence of information never upgrades a source.

### 3. Rank importance within the eligible set
Useful signals, roughly in order of reliability:

- **Citations relative to peers** (percentile within field and year) beats raw counts — a 2024 paper with 80 citations may outrank a 2010 paper with 800.
- **Citation velocity** (citations/year) indicates rising influence, but shrink the estimate for papers under ~2 years old: tiny denominators produce flukes.
- **Network position:** papers referenced by multiple independent important papers are structurally important even with modest counts.
- **Source quality** is a weak tiebreaker, not a primary signal.

### 4. Grade the evidence, not just the paper
For each claim you extract, note the evidence type behind it:

| Grade | Evidence type |
|---|---|
| A | Replicated experiments, meta-analysis, validated against independent data |
| B | Single well-controlled experiment or validated simulation |
| C | Simulation/model without experimental validation; small-n results |
| D | Position paper, preprint claims, qualitative argument |

A field where every supporting paper is grade C/D has weak foundations — say so explicitly.

### 5. Synthesize with a claim ledger
Every claim in the output maps to specific papers. Use this structure:

```
Claim: [one sentence]
Support: [Author Year] (grade B), [Author Year] (grade C)
Counter-evidence or gaps: [...]
Confidence: high / moderate / low — and why
```

If a claim has no entry in the ledger, delete the claim.

## Pitfalls to actively check for

- **Citation-as-relevance leakage** — the failure mode this skill exists to prevent.
- **Survivorship of search results:** the database's ranking already filtered what you see; note what the query may have missed.
- **Recency framing:** "recent" must mean age-since-publication, not position within an arbitrary date window.
- **Redundancy masquerading as consensus:** five papers from one lab is one line of evidence, not five.
- **Retracted/withdrawn papers:** check before citing anything as support.
- **Distinctiveness ≠ novelty:** you can show an idea is distinct within the retrieved evidence; you cannot prove it is globally novel from one database.

## Output standard

Deliverables include: the precise question, the gating criteria used, an evidence table (paper, year, aboutness grade, evidence grade, key finding), the claim ledger, explicit gaps/limitations, and a one-paragraph honest summary of evidence strength. Every displayed ranking must be explainable from its inputs — if you can't say *why* a paper ranked where it did, re-derive the ranking.
EOF

mkdir -p "$AGENTS_DIR/engineering-problem-solving"
cat > "$AGENTS_DIR/engineering-problem-solving/SKILL.md" <<'EOF'
---
name: engineering-problem-solving
description: Rigorous first-principles approach to engineering analysis, design, calculations, debugging, and technical review — at professional design-review standard, not classroom standard. Use this skill whenever the task involves engineering calculations, mechanical/structural/thermal/fluid analysis, design decisions, material selection, failure analysis, tolerancing, safety factors, test planning, reviewing technical work, or any problem where a wrong number or missed failure mode has real consequences — even if the user just asks "check my math", "will this part hold", "review my design", or "why did this break".
---

# Engineering Problem Solving

Solve and review engineering problems the way a senior engineer does in a design review: assumptions explicit, units carried, load paths traced, failure modes enumerated, every number defensible.

## The method

### 1. Frame before you compute
State in writing: what is being asked, knowns, unknowns, and the success criterion with a number and a unit ("deflection < 2 mm at 500 N", not "stiff enough"). If the requirement has no number, getting one *is* the first task.

### 2. Make every assumption explicit — then attack it
List assumptions before analysis: boundary conditions, load cases (including worst credible case, not just nominal), material state (as-rolled vs. annealed vs. welded HAZ), temperature, environment, duty cycle. For each, note whether it is conservative or optimistic. An unstated optimistic assumption is the most common root cause of analysis being wrong.

### 3. Draw the free body / trace the path
For mechanics: a free-body diagram with every force, moment, and reaction, checked for equilibrium. For other domains, the equivalent discipline: trace the load path, heat path, current path, or signal path end-to-end. Anything that enters must exit. Interfaces (joints, welds, bolts, connectors) are where paths concentrate and designs fail — give them their own analysis, never assume them rigid and perfect.

### 4. Governing equations before numbers
Write the symbolic relationship first, check its limiting behavior (does deflection → 0 as stiffness → ∞?), then substitute numbers. Carry units through every line — a units check catches a large share of all calculation errors. Use consistent SI internally; convert at the boundary.

### 5. Sanity-check every result three ways
- **Order of magnitude:** is 10⁴ MPa stress in aluminum plausible? (No — yield is ~10² MPa.)
- **Independent path:** estimate the same quantity by a different method (hand calc vs. simulation, energy method vs. force method).
- **Comparable hardware:** does the answer match what similar real designs use?

A result that fails any check is wrong until shown otherwise.

### 6. Enumerate failure modes, not just the obvious one
Run the checklist even when the answer "obviously" passes static strength: yield, fracture, fatigue (mean + alternating stress, stress concentrations Kt, surface finish), buckling (any slender member in compression), creep (T > ~0.4·Tm), wear, corrosion/galvanic pairs, vibration/resonance (forcing vs. natural frequencies), thermal expansion mismatch, loosening of fasteners. State which modes govern and which were screened out and why. Fatigue and buckling are the two most-missed governing modes.

### 7. Safety factors with justification
A safety factor is a claim about uncertainty, not a tradition. Justify the value from: load uncertainty, material property scatter, model fidelity, consequence of failure, and the applicable code/standard (ASME, AISC, ISO, FAA…). "FoS = 2 because that's typical" is not engineering. Distinguish factor against yield vs. ultimate vs. fatigue life.

### 8. Design for manufacturing and verification
Every dimension that matters gets a tolerance, and tolerances stack — check the worst-case (or RSS) stack against the functional requirement. Confirm the part can be made by the assumed process (draft angles, tool access, minimum wall, weldability) and *inspected* (a requirement you can't measure isn't a requirement). Define the test that would prove the design: load case, instrumentation, pass/fail number, and sample size.

## Reviewing someone else's work

Use the same method in reverse — and report findings in this format:

| Issue | Why it matters | Severity | How to fix it | Strong approach |
|---|---|---|---|---|

Severity scale: **Critical** (unsafe / fails requirement), **Major** (wrong result or unjustified margin), **Minor** (clarity, formatting, traceability). Check, in order: requirement defined → assumptions stated → FBD/load path correct → equations and units → numbers and arithmetic → failure modes covered → margins justified → manufacturable and testable → claims traceable to evidence. Be direct: a soft review that misses a governing failure mode helps no one.

## Communication standard

State the answer first, with its margin and governing failure mode. Then assumptions, method, and the numbers. Figures get axes, units, and captions; tables get sources. Distinguish *calculated* from *assumed* from *looked-up* values — and cite where looked-up values came from. Flag every result that depends on an unverified assumption.

## Anti-patterns

- Computing before framing ("plug and chug")
- Nominal-load-only analysis with no worst case
- Simulation results accepted without a hand-calc cross-check or mesh/convergence evidence
- Safety factor applied to the wrong quantity (stress vs. load vs. life — they differ for nonlinear problems)
- Treating a datasheet "typical" value as a minimum
- Reporting more significant figures than the inputs justify
EOF

mkdir -p "$AGENTS_DIR/project-builder"
cat > "$AGENTS_DIR/project-builder/SKILL.md" <<'EOF'
---
name: project-builder
description: Turn evidence (papers, data, prior art, requirements) into well-scoped, executable project plans with concrete first experiments and honest feasibility assessment. Use this skill whenever the task involves generating project ideas, scoping a research or engineering project, choosing between project directions, planning an MVP or prototype, defining milestones and first experiments, or evaluating whether a proposed project is feasible and worth doing — even if the user just says "what should I build", "give me project ideas from these papers", or "help me plan this project".
---

# Project Builder

Generate and scope projects that are evidence-backed, specific, executable, and honest about what they can claim.

## Doctrine

A good project direction is a *supported combination*, not an invention. It assembles ingredients that the evidence actually contains, and its first step is an experiment someone can run next week. Avoid the two failure poles: the vague aspiration ("use ML to improve manufacturing") and the unsupported fantasy (a method/system pairing no evidence connects).

## Step 1 — Extract ingredients from the evidence

From the papers, prior art, or requirements at hand, list:

- **Methods:** techniques with a track record (CFD, surrogate modeling, PID control, fatigue testing, topology optimization…)
- **Systems / applications:** concrete hardware or domains (HVAC diffusers, battery packs, robotic grippers…)
- **Outcomes:** measurable quantities (pressure drop, temperature uniformity, cycle life, positioning accuracy…)
- **Data & materials available:** datasets, test rigs, sensor logs, materials on hand
- **Limitations in the evidence:** weak validation, sparse benchmarks, fragmented results — these are project opportunities, not just caveats

## Step 2 — Form candidates under hard constraints

A candidate qualifies only if it:

1. Has at least one supporting source per claimed ingredient
2. Combines **at least two of**: method, system/application, measurable outcome
3. Uses only method↔system pairings the evidence supports (or explicitly labels the pairing as the hypothesis being tested)
4. Is not a duplicate of another candidate with different outcome words
5. Names a concrete first experiment
6. Traces every element back to its sources

## Step 3 — Score and rank candidates

```
30% evidence strength   — how many independent sources support it, and how directly
25% specificity         — named method + named system + numeric outcome beats generalities
20% execution fit       — matches available skills, equipment, budget, and timeline
15% distinctiveness     — different from the other candidates and from what the evidence already saturates
10% traceability        — every claim maps to a source
```

Use **distinctiveness, not novelty** — you can show a project differs from the retrieved evidence; you cannot prove global novelty from one search. Never claim "no one has done this."

## Step 4 — Merge duplicates, keep real distinctions

Merge candidates into one multi-objective project when their outcomes can be measured by the **same experiment or dataset** (e.g., three surrogate-modeling-for-HVAC projects differing only in outcome metric). Keep candidates separate when they need different methods, different physics, different data sources, special safety evidence, or substantially different experiments. Fewer, stronger directions beat a full card deck of near-duplicates.

## Step 5 — Define the first experiment

Every project ships with a first experiment specified to this standard:

- **Hypothesis:** one falsifiable sentence
- **Setup:** equipment/data/tools, with what already exists vs. must be acquired
- **Variables:** what is varied, what is measured, what is held constant
- **Success criterion:** a number — "surrogate predicts pressure drop within 10% of CFD on 20 held-out cases"
- **Timebox:** smallest version runnable in 1–2 weeks
- **Kill criterion:** the result that would tell you to stop or pivot

If you can't write the kill criterion, the project isn't scoped yet.

## Output format

For each project direction:

```
## [Project title — method + system + outcome]
Why this, why now: [2-3 sentences grounded in the evidence's gaps]
Supporting evidence: [sources, with what each contributes]
Scope: in / out
First experiment: [the 6-field spec above]
Risks & honest limits: [feasibility risks; what this project cannot claim]
Score: [the 5-factor breakdown, not just a total]
```

## Pitfalls

- Filling every slot: present 3 strong directions over 8 weak ones
- Outcome-word duplication dressed as variety
- "Novel" claims from limited evidence
- First experiments that are actually month-three experiments — shrink until it fits two weeks
- Scoring execution fit against an idealized team instead of the actual person/resources
- Ignoring the limitations in the evidence — the gaps are where the best projects live
EOF

# ------------------------------------------------------------------ symlinks
link_skill () {
  local target_dir="$1" name="$2"
  local link="$target_dir/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    mv "$link" "${link}.backup-$(date +%Y%m%d%H%M%S)"
    echo "  backed up existing: $link"
  fi
  ln -sfn "$AGENTS_DIR/$name" "$link"
}

for s in "${SKILLS[@]}"; do
  link_skill "$CLAUDE_DIR" "$s"
  link_skill "$CODEX_DIR" "$s"
done

# ------------------------------------------------------------------- verify
echo
echo "Installed in $AGENTS_DIR:"
ls -1 "$AGENTS_DIR"
echo
echo "Claude symlinks:"
ls -l "$CLAUDE_DIR" | grep -- '->' || true
echo
echo "Codex symlinks:"
ls -l "$CODEX_DIR" | grep -- '->' || true
echo
echo "Done. Edit any SKILL.md in ~/.agents/skills/ once — both agents see the change."
