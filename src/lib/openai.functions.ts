import { createServerFn } from "@tanstack/react-start";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o";
const SCREEN_MODEL = "gpt-4o-mini";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callOpenAI(body: unknown): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const maxAttempts = 4;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("OpenAI: invalid API key.");
    if (res.status === 402) throw new Error("OpenAI: quota exhausted / billing.");
    if (res.status === 429) {
      // Rate-limited — honor Retry-After when present, otherwise exp backoff.
      const ra = res.headers.get("retry-after");
      const raMs = ra ? Number(ra) * 1000 : NaN;
      const backoff = Number.isFinite(raMs) && raMs > 0
        ? Math.min(raMs, 15000)
        : Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 400);
      lastErr = `OpenAI rate limit (429) — attempt ${attempt}/${maxAttempts}`;
      if (attempt < maxAttempts) {
        await sleep(backoff);
        continue;
      }
      throw new Error("OpenAI rate limit — retry shortly.");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Retry transient 5xx too.
      if (res.status >= 500 && attempt < maxAttempts) {
        lastErr = `OpenAI ${res.status}`;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
        continue;
      }
      throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 300)}`);
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return (j.choices?.[0]?.message?.content ?? "").trim();
  }
  throw new Error(lastErr || "OpenAI: exhausted retries");
}

/* =========================================================
   screenCandidate: cheap pre-screen gate before the full
   scoreCandidate call. Uses gpt-4o-mini to reject only clear
   disqualifiers (no usable text at all, spam/irrelevant repo,
   obviously off-thesis domain). Returns {pass, reason}.
   ========================================================= */
export type ScreenResult = { pass: boolean; reason: string };

export const screenCandidate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { text?: unknown; thesis?: unknown };
    if (typeof v?.text !== "string")
      throw new Error("text required");
    return {
      text: v.text,
      thesis: typeof v?.thesis === "string" ? v.thesis : "",
    };
  })
  .handler(async ({ data }): Promise<ScreenResult> => {
    const text = data.text.trim();
    if (!text) {
      return { pass: false, reason: "no usable signal text" };
    }

    const system =
      "You are a strict but conservative pre-screener for a VC deal-sourcing pipeline. " +
      "You DO NOT score. You only reject clear disqualifiers so we don't spend a full " +
      "GPT-4o scoring pass on obvious noise. Reject ONLY for: " +
      "(a) no usable text at all, " +
      "(b) spam / SEO farm / promo repo / joke or tutorial-copy content, " +
      "(c) obviously off-thesis domain when a thesis is provided. " +
      "When in doubt, PASS — a borderline builder must go through to full scoring. " +
      "Return STRICT JSON only: {\"pass\": bool, \"reason\": string}. " +
      "reason must be ONE short sentence.";

    const user =
      (data.thesis ? `Thesis (domain-restricted if non-empty): ${data.thesis}\n\n` : "") +
      `Candidate signal text:\n${text.slice(0, 4000)}`;

    const raw = await callOpenAI({
      model: SCREEN_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    try {
      const j = JSON.parse(raw) as { pass?: unknown; reason?: unknown };
      return {
        pass: j.pass !== false, // default to pass on ambiguous output
        reason:
          typeof j.reason === "string" && j.reason.trim()
            ? j.reason.trim()
            : j.pass === false
              ? "disqualified"
              : "ok",
      };
    } catch {
      // Fail open — if the cheap screener misbehaves, don't block scoring.
      return { pass: true, reason: "screener parse error — passing through" };
    }
  });

/* =========================================================
   generateMemo: takes a founderId, loads the row, asks GPT-4o
   for an evidence-cited investment memo with fixed sections.
   Returns { text } — plain text with section headings the
   existing MemoView renders as-is.
   ========================================================= */
export const generateMemo = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { founderId?: unknown };
    if (typeof v?.founderId !== "string" || !v.founderId)
      throw new Error("founderId required");
    return { founderId: v.founderId };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("founders")
      .select("*")
      .eq("id", data.founderId)
      .maybeSingle();
    if (error) throw new Error(`DB: ${error.message}`);
    if (!row) throw new Error("Founder not found");

    const system =
      "You are an evidence-first VC analyst writing a $100K/24-hour investment memo. " +
      "Output PLAIN TEXT (no markdown symbols like #, *, _). " +
      "Use these exact section headings, in this order, each on its own line, uppercase: " +
      "COMPANY SNAPSHOT / INVESTMENT HYPOTHESES / SWOT / PROBLEM & PRODUCT / TRACTION & KPIS / RECOMMENDATION. " +
      "Rules: (1) every factual claim must cite its evidence id inline in square brackets " +
      "(e.g. [S-402] for a signal, [C-1] for a claim). Use the exact ids present in the record. " +
      "(2) Any data gap must be flagged verbatim as 'MISSING — not in evidence' — never invented, " +
      "never estimated. (3) Contradictions surface in SWOT weaknesses and the recommendation. " +
      "(4) SWOT lists Strengths / Weaknesses / Opportunities / Threats as sub-bullets. " +
      "(5) RECOMMENDATION must be explicit: INVEST $100K, PASS, or INVESTIGATE (with the single blocking question). " +
      "(6) Be terse. Padding counts against you.";

    const record = JSON.stringify(row);
    const prompt =
      `Founder record (all evidence, trust scores, flags, gaps included):\n${record}\n\n` +
      "Write the investment memo now. Cite evidence ids that appear in the record; " +
      "flag anything else as 'MISSING — not in evidence'.";

    const text = await callOpenAI({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    return { founderId: data.founderId, text };
  });

/* =========================================================
   scoreCandidate: takes an identity_key from people_candidates,
   loads the candidate row + its signals, asks GPT-4o for three
   axis scores (1–10, or unscorable) each with a one-line
   evidence-cited reason.
   ========================================================= */

export type AxisScore = {
  score: number | null;
  low: number | null;
  high: number | null;
  reason: string;
  unscorable: boolean;
};
export type CandidateScore = {
  founder: AxisScore;
  market: AxisScore;
  idea_vs_market: AxisScore;
  sources_used: string[];
  sector: string | null;
  stage: string | null;
  geo: string | null;
};

export const scoreCandidate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { identityKey?: unknown };
    if (typeof v?.identityKey !== "string" || !v.identityKey)
      throw new Error("identityKey required");
    return { identityKey: v.identityKey };
  })
  .handler(async ({ data }): Promise<CandidateScore> => {
    // Enrich first: adds GitHub profile + Tavily web evidence so market /
    // idea_vs_market axes have real facts to cite, not general knowledge.
    const { enrichCandidate } = await import("./enrich.functions");
    const enriched = await enrichCandidate({ data: { identityKey: data.identityKey } });

    const system =
      "You are an evidence-first VC scorer. Score three independent axes for a candidate, " +
      "each on a 1–10 integer scale, using ONLY the cited raw signals, GitHub profile, AND retrieved web evidence below. " +
      "If evidence for an axis is thin, absent, or contradictory, mark it unscorable=true " +
      "with score=null and reason starting 'unscorable — flagged: ...'. " +
      "Never invent facts, metrics, or affiliations. Cite signal_ids inline like [signal_id]. " +
      "For web evidence, cite the source URL inline in parentheses (e.g. (example.com)). " +
      "Market and idea_vs_market reasoning MUST cite a specific fact, figure, or quote from the " +
      "provided evidence — never reason from general knowledge of the space alone. If the enriched " +
      "evidence still doesn't contain a usable fact for an axis, mark it unscorable — do not fill " +
      "the gap with inference. " +
      "Reasons must be ONE sentence. Return STRICT JSON only, no prose, no backticks. " +
      "Schema: {\"founder\":{\"score\":int|null,\"reason\":str,\"unscorable\":bool}," +
      "\"market\":{...},\"idea_vs_market\":{...},\"sources_used\":[str]}. " +
      "Axis definitions: founder = builder track record from public artifacts; " +
      "market = size / demand / timing of the space they're in; " +
      "idea_vs_market = fit between their specific project and that market.";

    const payload = {
      candidate: {
        person_or_handle: enriched.person_or_handle,
        identity_key: enriched.identity_key,
        companies: enriched.companies,
        cold_start: enriched.cold_start,
      },
      signals: enriched.signals,
      github_profile: enriched.github_profile,
      web_evidence: enriched.web_evidence,
    };

    const text = await callOpenAI({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });

    let parsed: CandidateScore;
    try {
      parsed = JSON.parse(text) as CandidateScore;
    } catch {
      throw new Error("Scorer returned malformed JSON");
    }

    // Spread narrows as evidence count/reliability increases.
    // Base 3.0; log-scale by count; scaled by (1.2 - 0.4*avgReliability).
    const n = enriched.evidence_count;
    const rel = enriched.avg_reliability;
    const baseSpread =
      Math.max(0.5, 3 - Math.log2(1 + n) * 0.6) * (1.2 - rel * 0.4);
    const round1 = (v: number) => Math.round(v * 10) / 10;

    // Normalize / guard
    const clean = (a: unknown): AxisScore => {
      const x = (a ?? {}) as Partial<AxisScore>;
      const un = Boolean(x.unscorable) || x.score == null;
      if (un) {
        return {
          score: null,
          low: null,
          high: null,
          reason:
            typeof x.reason === "string"
              ? x.reason
              : "unscorable — flagged: no reason returned",
          unscorable: true,
        };
      }
      const score = Math.max(1, Math.min(10, Math.round(Number(x.score) || 0)));
      const low = round1(Math.max(1, score - baseSpread));
      const high = round1(Math.min(10, score + baseSpread));
      return {
        score,
        low,
        high,
        reason:
          typeof x.reason === "string"
            ? x.reason
            : "unscorable — flagged: no reason returned",
        unscorable: false,
      };
    };

    const result: CandidateScore = {
      founder: clean(parsed.founder),
      market: clean(parsed.market),
      idea_vs_market: clean(parsed.idea_vs_market),
      sources_used: Array.isArray(parsed.sources_used)
        ? parsed.sources_used.filter((x): x is string => typeof x === "string")
        : [],
      sector: null,
      stage: null,
      geo: null,
    };
    // Note: sector/stage/geo classification is done by the separate,
    // cheap `classifyCandidate` server fn (below) — kept out of this
    // expensive scoring path so classification never adds latency/cost
    // to a full score call.

    // Composite founder_score: weighted rollup of the three axes.
    // Skip null (unscorable) axes — don't average across unscorable ones.
    // Weights: founder 0.5, market 0.3, idea_vs_market 0.2 (renormalized
    // across whichever axes actually have a score).
    const weights: Array<[keyof CandidateScore, number]> = [
      ["founder", 0.5],
      ["market", 0.3],
      ["idea_vs_market", 0.2],
    ];
    let wSum = 0;
    let vSum = 0;
    let lowSum = 0;
    let highSum = 0;
    for (const [k, w] of weights) {
      const ax = result[k] as AxisScore;
      if (!ax || ax.unscorable || ax.score == null) continue;
      wSum += w;
      vSum += ax.score * w;
      lowSum += (ax.low ?? ax.score) * w;
      highSum += (ax.high ?? ax.score) * w;
    }
    const composite = wSum > 0
      ? {
          value: round1(vSum / wSum),
          low: round1(lowSum / wSum),
          high: round1(highSum / wSum),
        }
      : null;

    // Persist onto the people_candidates row: merge axes, append composite
    // value to momentum (cap 10), set scored_at = now(). Non-fatal on error.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: existing } = await supabaseAdmin
        .from("people_candidates")
        .select("momentum, founder_score")
        .eq("identity_key", data.identityKey)
        .maybeSingle();
      const prevMomentum = Array.isArray((existing as { momentum?: unknown } | null)?.momentum)
        ? ((existing as { momentum: unknown[] }).momentum as number[])
        : [];
      const prevFs = (existing as { founder_score?: { value?: number } | null } | null)?.founder_score ?? null;
      const nextMomentum =
        composite != null
          ? [...prevMomentum, composite.value].slice(-10)
          : prevMomentum;
      const trend =
        composite && prevFs && typeof prevFs.value === "number"
          ? composite.value > prevFs.value
            ? "up"
            : composite.value < prevFs.value
              ? "down"
              : "flat"
          : "flat";
      const founderScoreRow = composite
        ? {
            value: composite.value,
            low: composite.low,
            high: composite.high,
            trend,
            coldStart: enriched.cold_start,
          }
        : null;
      await supabaseAdmin
        .from("people_candidates")
        .update({
          axes: result as unknown as never,
          founder_score: founderScoreRow as unknown as never,
          momentum: nextMomentum as unknown as never,
          scored_at: new Date().toISOString(),
          sector: result.sector as unknown as never,
          stage: result.stage as unknown as never,
          geo: result.geo as unknown as never,
        })
        .eq("identity_key", data.identityKey);
    } catch {
      // persistence is best-effort — never fail the score call
    }

    return result;
  });

/* scoreFounder — identityKey-agnostic path. Scores a founders row
   (typically an inbound application) using enrichFounder for evidence,
   then persists axes/founder_score/momentum back onto founders. */
export const scoreFounder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { founderId?: unknown };
    if (typeof v?.founderId !== "string" || !v.founderId)
      throw new Error("founderId required");
    return { founderId: v.founderId };
  })
  .handler(async ({ data }): Promise<CandidateScore> => {
    const { enrichFounder } = await import("./enrich.functions");
    const enriched = await enrichFounder({ data: { founderId: data.founderId } });

    const system =
      "You are an evidence-first VC scorer. Score three independent axes for an inbound founder application, " +
      "each on a 1–10 integer scale, using ONLY the cited raw signals AND retrieved web evidence below. " +
      "If evidence for an axis is thin, absent, or contradictory, mark it unscorable=true " +
      "with score=null and reason starting 'unscorable — flagged: ...'. " +
      "Never invent facts, metrics, or affiliations. Cite web sources inline in parentheses (e.g. (example.com)). " +
      "Market and idea_vs_market reasoning MUST cite a specific fact, figure, or quote from the " +
      "provided evidence — never reason from general knowledge of the space alone. " +
      "Reasons must be ONE sentence. Return STRICT JSON only. " +
      "Schema: {\"founder\":{\"score\":int|null,\"reason\":str,\"unscorable\":bool}," +
      "\"market\":{...},\"idea_vs_market\":{...},\"sources_used\":[str]}.";

    const payload = {
      candidate: {
        person_or_handle: enriched.person_or_handle,
        companies: enriched.companies,
        cold_start: enriched.cold_start,
        track: "inbound",
      },
      signals: enriched.signals,
      web_evidence: enriched.web_evidence,
    };

    const text = await callOpenAI({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
    });

    let parsed: CandidateScore;
    try {
      parsed = JSON.parse(text) as CandidateScore;
    } catch {
      throw new Error("Scorer returned malformed JSON");
    }

    const n = enriched.evidence_count;
    const rel = enriched.avg_reliability;
    const baseSpread =
      Math.max(0.5, 3 - Math.log2(1 + n) * 0.6) * (1.2 - rel * 0.4);
    const round1 = (v: number) => Math.round(v * 10) / 10;

    const clean = (a: unknown): AxisScore => {
      const x = (a ?? {}) as Partial<AxisScore>;
      const un = Boolean(x.unscorable) || x.score == null;
      if (un) {
        return {
          score: null,
          low: null,
          high: null,
          reason:
            typeof x.reason === "string"
              ? x.reason
              : "unscorable — flagged: no reason returned",
          unscorable: true,
        };
      }
      const score = Math.max(1, Math.min(10, Math.round(Number(x.score) || 0)));
      return {
        score,
        low: round1(Math.max(1, score - baseSpread)),
        high: round1(Math.min(10, score + baseSpread)),
        reason:
          typeof x.reason === "string"
            ? x.reason
            : "unscorable — flagged: no reason returned",
        unscorable: false,
      };
    };

    const result: CandidateScore = {
      founder: clean(parsed.founder),
      market: clean(parsed.market),
      idea_vs_market: clean(parsed.idea_vs_market),
      sources_used: Array.isArray(parsed.sources_used)
        ? parsed.sources_used.filter((x): x is string => typeof x === "string")
        : [],
      sector: null,
      stage: null,
      geo: null,
    };

    // Composite founder_score (weighted; skip unscorable axes).
    const weights: Array<[keyof CandidateScore, number]> = [
      ["founder", 0.5],
      ["market", 0.3],
      ["idea_vs_market", 0.2],
    ];
    let wSum = 0, vSum = 0, lowSum = 0, highSum = 0;
    for (const [k, w] of weights) {
      const ax = result[k] as AxisScore;
      if (!ax || ax.unscorable || ax.score == null) continue;
      wSum += w;
      vSum += ax.score * w;
      lowSum += (ax.low ?? ax.score) * w;
      highSum += (ax.high ?? ax.score) * w;
    }
    const composite = wSum > 0
      ? {
          value: round1(vSum / wSum),
          low: round1(lowSum / wSum),
          high: round1(highSum / wSum),
        }
      : null;

    // Persist onto founders row. Map to the seed founders schema shape:
    //   axes: { founder|market|ideaVsMarket: {score, trend, note} }
    //   founder_score: { value, low, high, trend, coldStart }
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: existing } = await supabaseAdmin
        .from("founders")
        .select("momentum, founder_score")
        .eq("id", data.founderId)
        .maybeSingle();
      const prevMomentum = Array.isArray((existing as { momentum?: unknown } | null)?.momentum)
        ? ((existing as { momentum: unknown[] }).momentum as number[])
        : [];
      const prevFs = (existing as { founder_score?: { value?: number } | null } | null)?.founder_score ?? null;
      const nextMomentum =
        composite != null
          ? [...prevMomentum, composite.value].slice(-10)
          : prevMomentum;
      const trend =
        composite && prevFs && typeof prevFs.value === "number" && prevFs.value > 0
          ? composite.value > prevFs.value
            ? "up"
            : composite.value < prevFs.value
              ? "down"
              : "flat"
          : "flat";

      const { toDisplayAxes } = await import("./adapters");
      const axesRow = toDisplayAxes(result, `founder:${data.founderId}`);
      const founderScoreRow = composite
        ? {
            value: composite.value,
            low: composite.low,
            high: composite.high,
            trend,
            coldStart: enriched.cold_start,
          }
        : {
            value: 0,
            low: 0,
            high: 0,
            trend: "flat",
            coldStart: enriched.cold_start,
          };

      await supabaseAdmin
        .from("founders")
        .update({
          axes: axesRow as unknown as never,
          founder_score: founderScoreRow as unknown as never,
          momentum: nextMomentum as unknown as never,
          gaps: (composite ? [] : ["Insufficient evidence to score"]) as unknown as never,
        })
        .eq("id", data.founderId);
    } catch (e) {
      console.warn("scoreFounder persist failed:", e);
    }

    return result;
  });