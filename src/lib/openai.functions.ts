import { createServerFn } from "@tanstack/react-start";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o";

async function callOpenAI(body: unknown): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("OpenAI: invalid API key.");
  if (res.status === 429) throw new Error("OpenAI rate limit — retry shortly.");
  if (res.status === 402) throw new Error("OpenAI: quota exhausted / billing.");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 300)}`);
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (j.choices?.[0]?.message?.content ?? "").trim();
}

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
};

function normalizeIdentity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

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

    return {
      founder: clean(parsed.founder),
      market: clean(parsed.market),
      idea_vs_market: clean(parsed.idea_vs_market),
      sources_used: Array.isArray(parsed.sources_used)
        ? parsed.sources_used.filter((x): x is string => typeof x === "string")
        : [],
    };
  });