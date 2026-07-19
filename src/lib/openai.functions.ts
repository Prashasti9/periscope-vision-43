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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: candidate, error: cErr } = await supabaseAdmin
      .from("people_candidates")
      .select("*")
      .eq("identity_key", data.identityKey)
      .maybeSingle();
    if (cErr) throw new Error(`DB: ${cErr.message}`);
    if (!candidate) throw new Error("Candidate not found");

    // Pull signals whose person_or_handle normalizes to the same identity key.
    const { data: rawSignals, error: sErr } = await supabaseAdmin
      .from("signals")
      .select("*")
      .ilike("person_or_handle", candidate.person_or_handle);
    if (sErr) throw new Error(`DB: ${sErr.message}`);

    const signals = (rawSignals ?? []).filter(
      (s) => normalizeIdentity(s.person_or_handle) === data.identityKey,
    );

    // --- Auto-run Deep Diligence: fetch web evidence via Tavily, persist to
    // real_signals, then feed both raw signals AND web evidence into the scorer
    // so market / idea-vs-market axes have something to reason from.
    const subject = candidate.person_or_handle;
    const companyHint = (candidate.companies ?? "")
      .split(/[,;|]/)
      .map((x) => x.trim())
      .filter(Boolean)[0] ?? "";
    const query = `${subject} ${companyHint} founder startup market`.replace(/\s+/g, " ").trim();

    type WebEvidence = { title: string; url: string; content: string; score: number };
    let webEvidence: WebEvidence[] = [];

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      try {
        const tavRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tavilyKey}`,
          },
          body: JSON.stringify({
            query,
            search_depth: "advanced",
            max_results: 6,
            include_raw_content: true,
          }),
        });
        if (tavRes.ok) {
          const tavJson = (await tavRes.json()) as {
            results?: Array<{
              title?: string;
              url?: string;
              content?: string;
              raw_content?: string;
              score?: number;
            }>;
          };
          webEvidence = (tavJson.results ?? []).map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            content: (r.content ?? r.raw_content ?? "").slice(0, 3000),
            score: typeof r.score === "number" ? r.score : 0,
          }));

          if (webEvidence.length) {
            const today = new Date().toISOString().slice(0, 10);
            await supabaseAdmin.from("real_signals").insert(
              webEvidence.map((e) => ({
                source: "tavily",
                subject,
                query,
                title: e.title,
                url: e.url,
                content: e.content,
                score: e.score,
                reliability: 0.7,
                date: today,
              })),
            );
          }
        }
      } catch {
        // Non-fatal: fall back to scoring on raw signals alone.
        webEvidence = [];
      }
    }

    const system =
      "You are an evidence-first VC scorer. Score three independent axes for a candidate, " +
      "each on a 1–10 integer scale, using ONLY the cited raw signals AND retrieved web evidence below. " +
      "If evidence for an axis is thin, absent, or contradictory, mark it unscorable=true " +
      "with score=null and reason starting 'unscorable — flagged: ...'. " +
      "Never invent facts, metrics, or affiliations. Cite signal_ids inline like [signal_id]. " +
      "For web evidence, cite the source URL inline in parentheses (e.g. (example.com)). " +
      "Reasons must be ONE sentence. Return STRICT JSON only, no prose, no backticks. " +
      "Schema: {\"founder\":{\"score\":int|null,\"reason\":str,\"unscorable\":bool}," +
      "\"market\":{...},\"idea_vs_market\":{...},\"sources_used\":[str]}. " +
      "Axis definitions: founder = builder track record from public artifacts; " +
      "market = size / demand / timing of the space they're in; " +
      "idea_vs_market = fit between their specific project and that market.";

    const payload = {
      candidate: {
        person_or_handle: candidate.person_or_handle,
        identity_key: candidate.identity_key,
        source_count: candidate.source_count,
        signal_count: candidate.signal_count,
        sources: candidate.sources,
        companies: candidate.companies,
      },
      signals: signals.map((s) => ({
        signal_id: s.signal_id,
        source: s.source,
        text: s.text,
        url: s.url,
        company: s.company,
        date: s.date,
        reliability: s.reliability,
      })),
      web_evidence: webEvidence.map((e, i) => ({
        idx: `W-${i}`,
        title: e.title,
        url: e.url,
        relevance: e.score,
        content: e.content,
      })),
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

    // Normalize / guard
    const clean = (a: unknown): AxisScore => {
      const x = (a ?? {}) as Partial<AxisScore>;
      const un = Boolean(x.unscorable) || x.score == null;
      return {
        score: un ? null : Math.max(1, Math.min(10, Math.round(Number(x.score) || 0))),
        reason: typeof x.reason === "string" ? x.reason : "unscorable — flagged: no reason returned",
        unscorable: un,
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