# Founder Compass — How It Works, and Why It Was Built This Way

This document explains what Founder Compass is, how it's built, and the reasoning behind the key decisions made along the way. It's written for anyone — technical or not — who wants to understand the product, not just look at the code.

---

## 1. What is Founder Compass?

Venture capital investors ("VCs") are trying to find promising early-stage founders before everyone else notices them. The problem is that the public evidence about who's worth watching — GitHub activity, Hacker News posts, academic papers, Y Combinator company data — is scattered everywhere and too much for a person to track by hand.

**Founder Compass** is a dashboard that collects that public evidence about early-stage founders and builders, scores them, and helps an investor decide who's worth a closer look — while always showing *why* it's making that suggestion.

The one-sentence version of the whole product: **show evidence, not verdicts.** Founder Compass never tells you "this person is a great founder" as a bare claim — it shows you the GitHub repo, the HN post, the funding record, and lets you judge for yourself. If it doesn't have enough evidence to say something, it says so, instead of guessing.

---

## 2. The core design principle (and why almost every feature traces back to it)

Early in the project, the product brief set a strict rule: **never assert something you can't back up with a link.** A few concrete ways this shows up in the app:

- People pulled from public data are shown as **"people candidates,"** never as "founders" — having a GitHub account or writing a Hacker News post isn't proof someone has started a company.
- Instead of one overall "score," every candidate gets **three separate scores** — Founder, Market, and Traction (called `idea_vs_market` internally) — because blending them into a single number would hide *which* part of the story is actually strong.
- When there isn't enough evidence to score an axis honestly, Founder Compass marks it **"unscorable"** rather than inventing a number. In AI-generated investment memos, any missing fact is literally labeled **"MISSING — not in evidence"** instead of being filled in with a guess.
- When Founder Compass does a live web search for extra evidence (via a tool called Tavily — more on that below), the results are shown as timestamped, unverified leads — never presented as confirmed fact.
- The "Deep Diligence" tab exists specifically to catch **contradictions**: if a claim someone makes doesn't match the evidence found about them, the app flags it in red rather than smoothing it over.

Every architecture and feature decision below supports this one idea: evidence stays visible, and confidence is never manufactured.

---

## 3. How the app is put together

Think of the app as three rooms:

```
   Your browser                 The back office                The filing cabinet
  (what you see)      <--->   (private server logic)   <--->      (the database)
                                       |
                                       v
                          Outside helpers it calls out to:
                     GitHub, Hacker News, arXiv, YC data,
                       OpenAI (GPT-4o), Tavily search
```

**The storefront — what you see in the browser**
The visual dashboard is built with **React** (a widely used toolkit for building interactive web pages) and a framework called **TanStack Start**, which handles page routing and talking to the server. The look and feel — buttons, cards, dark mode, charts — comes from a design system called **Tailwind + shadcn/ui**, which is a common, modern choice rather than something custom-built from scratch. This means the visual layer uses current, well-supported, standard web technology.

**The back office — private logic that runs on a server**
Some tasks shouldn't happen in your browser: talking to OpenAI, searching the web, or reading secret API keys. These live in small pieces of server-side logic (called "server functions"). The important thing for a non-technical reader: **anything that requires a secret password/key runs only on the server, never in the browser**, so those keys are never exposed to a visitor of the site.

**The filing cabinet — the database**
Founder Compass stores its data in **Supabase**, a hosted version of a well-known database technology (Postgres). It holds:
- `founders` — a small seed set of demo founder profiles with rich detail (scores, evidence, notes).
- `signals` and `people_candidates` — the raw public data points collected, and the deduplicated list of people/handles seen across sources.
- `real_signals` — cached results from live web searches.

The database also has built-in rules (called "Row-Level Security") that control who's allowed to read or write which rows — a safety net baked into the data layer itself, not just the app code.

**Outside helpers it calls out to**
- **GitHub, Hacker News, arXiv, and a YC company-data mirror** — sources of public activity signals about builders and companies.
- **OpenAI (GPT-4o)** — writes the investment memos and computes the three-axis scores, always required to cite its sources.
- **Tavily** — a web search service used for live, on-demand evidence lookups (e.g., "Deep Diligence" claim checks).
- **Lovable's own AI helper** — a separate, smaller in-app assistant feature, kept independent from the OpenAI-powered scoring/memo work described above.

---

## 4. Key decisions made along the way

Founder Compass was built quickly — over roughly three days — and the git history tells a clear story of decisions made in order:

1. **Started from a template, not from scratch.** The project began from a standard TanStack Start starter, so time wasn't spent rebuilding basic project setup that already exists as a well-tested pattern.

2. **Built the look and flows first, with placeholder data.** The tabs, layout, and interactions (Thesis Engine, Pipeline, Dossier, Memo) were built and refined before any real data was wired in — a common approach that lets design decisions get tested quickly without waiting on a real backend.

3. **Added a real database once the design held up.** Supabase was introduced mid-build to replace hardcoded demo data with an actual, persistent data store for founders, candidates, and scores.

4. **A one-time data-collection script, then retired.** A small Python script pulled real public data (GitHub, Hacker News, arXiv, YC) into spreadsheets, which were imported once to seed the database. Once that job was done, the script was removed from the project — like a moving truck that leaves once the furniture is in the house. (This is also why the repo's `README.md` still describes that original ingestion script — it's a leftover from that earlier step, and the actual, current version of this logic now lives in the app's own server code instead of a separate script.)

5. **A focused day of feature-building.** In quick succession: a live view of sourced candidates, a pipeline visualization, the "Deep Diligence" claim-verification tab (trust scores + contradiction flags), automatic web-search enrichment of candidates, and finally score persistence (below).

6. **Score persistence — the most recent change.** Previously, every time a candidate was scored, the result was thrown away and recalculated fresh next time. Now, each new score is saved and compared against the previous one, so Founder Compass can show whether a candidate's momentum is trending **up, down, or flat** over time — instead of losing that history on every re-score. Concretely: the three axis scores are combined into one overall number using fixed weights (Founder 50%, Market 30%, Traction 20%), and up to the last 10 scores are kept per candidate to compute the trend.

7. **A deliberate choice about where new server logic lives.** When it came time to wire real OpenAI scoring and memo-writing into the app, a specific decision was made to keep that logic inside the app's own server functions rather than creating a separate cloud function elsewhere — one place for private server logic, instead of two systems to maintain.

---

## 5. A tour of what each tab does

- **Thesis Engine** — lets an investor describe what they're looking for (geography, sector, technical depth, prior funding, etc.) and re-ranks candidates against that thesis, live.
- **Sourcing** — the raw feed of people/handles discovered from public sources, with the option to trigger a deeper look at any one of them.
- **Pipeline** (and its "Live" variant) — a visual, at-a-glance view of where each candidate sits, backed by real, scored candidates rather than demo data.
- **Founder dossier** — a detailed evidence file on one candidate: activity timeline, source badges (GitHub/HN/arXiv/YC), and trust indicators.
- **Memo** — generates a structured investment memo (company snapshot, hypotheses, SWOT, traction, recommendation), with every bullet tied to a citation — and anything unsupported explicitly marked "MISSING — not in evidence" rather than invented.
- **Deep diligence** — runs a live web search on a specific claim about a person or company and checks whether the evidence backs it up, supports it, or contradicts it — the tab most directly built around the "never manufacture confidence" principle.

---

## 6. Current state, honestly

Founder Compass is a demo/prototype, built for a challenge/showcase context rather than production use:
- There's no automated test suite yet — quality is currently checked through linting/formatting and manual review.
- The scaffolding for user sign-in exists in the code, but no login flow is actually wired up in the app yet — right now, everyone sees the same public demo data.
- The six seed founder profiles are fixed demo data, kept intentionally untouched while newer features (like OpenAI-powered scoring) were layered in around them.

None of this is unusual for a fast-moving demo build — it's included here so anyone picking this up next knows exactly what's real and what's still a stub.
