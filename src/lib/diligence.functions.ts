import { createServerFn } from "@tanstack/react-start";

export type DiligenceClaim = {
  claim: string;
  trust: number;
  source_url: string;
  evidence: string;
  contradiction: boolean;
  flag: string | null;
};

export type DiligenceEvidence = {
  title: string;
  url: string;
  content: string;
  score: number;
};

export type DiligenceResult = {
  subject: string;
  query: string;
  evidence: DiligenceEvidence[];
  claims: DiligenceClaim[];
  summary: string;
  raw_saved: number;
};

export const deepDiligence = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as { name?: unknown; company?: unknown };
    if (typeof v.name !== "string" || !v.name.trim())
      throw new Error("name required");
    return {
      name: v.name.trim(),
      company: typeof v.company === "string" ? v.company.trim() : "",
    };
  })
  .handler(async ({ data }): Promise<DiligenceResult> => {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) throw new Error("Missing TAVILY_API_KEY");
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const subject = data.company ? `${data.name} — ${data.company}` : data.name;
    const query = `${data.name} ${data.company} founder`.trim();

    // 1) Tavily search
    const tavRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tavilyKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: 8,
        include_raw_content: true,
      }),
    });
    if (!tavRes.ok) {
      const t = await tavRes.text().catch(() => "");
      throw new Error(`Tavily error ${tavRes.status}: ${t.slice(0, 300)}`);
    }
    const tavJson = (await tavRes.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        raw_content?: string;
        score?: number;
      }>;
    };
    const results = Array.isArray(tavJson.results) ? tavJson.results : [];
    const evidence: DiligenceEvidence[] = results.map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: (r.content ?? r.raw_content ?? "").slice(0, 4000),
      score: typeof r.score === "number" ? r.score : 0,
    }));

    // 2) Persist to real_signals
    const today = new Date().toISOString().slice(0, 10);
    let raw_saved = 0;
    if (evidence.length) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const rows = evidence.map((e) => ({
        source: "tavily",
        subject,
        query,
        title: e.title,
        url: e.url,
        content: e.content,
        score: e.score,
        reliability: 0.7,
        date: today,
      }));
      const { error } = await supabaseAdmin.from("real_signals").insert(rows);
      if (!error) raw_saved = rows.length;
    }

    // 3) Ask GPT-4o to extract claims with trust scores + contradictions
    const system =
      "You are an evidence-first VC diligence analyst. From the retrieved web search results, " +
      "extract concrete CLAIMS made about or by the founder/company (user counts, revenue, funding, " +
      "traction, team, launches). For each claim, assign trust in [0,1] based on how strongly the " +
      "retrieved evidence supports it, cite the exact source URL from the input, and set contradiction=true " +
      "if any other retrieved source contradicts it or the evidence is inconsistent. Do NOT invent claims " +
      "that are not present in the sources. If nothing concrete is found, return an empty claims array. " +
      "Return STRICT JSON only, no prose or markdown. Schema: " +
      "{\"summary\":str,\"claims\":[{\"claim\":str,\"trust\":number,\"source_url\":str,\"evidence\":str,\"contradiction\":bool,\"flag\":str|null}]}";

    const userPayload = {
      subject,
      query,
      evidence: evidence.map((e, i) => ({
        idx: i,
        title: e.title,
        url: e.url,
        score: e.score,
        content: e.content,
      })),
    };

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });
    if (!aiRes.ok) {
      const t = await aiRes.text().catch(() => "");
      throw new Error(`OpenAI error ${aiRes.status}: ${t.slice(0, 300)}`);
    }
    const aiJson = (await aiRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (aiJson.choices?.[0]?.message?.content ?? "").trim();

    let parsed: { summary?: string; claims?: DiligenceClaim[] } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { summary: "", claims: [] };
    }

    const claims: DiligenceClaim[] = Array.isArray(parsed.claims)
      ? parsed.claims.map((c) => ({
          claim: String(c.claim ?? ""),
          trust: Math.max(0, Math.min(1, Number(c.trust) || 0)),
          source_url: String(c.source_url ?? ""),
          evidence: String(c.evidence ?? ""),
          contradiction: Boolean(c.contradiction),
          flag: c.flag ? String(c.flag) : null,
        }))
      : [];

    return {
      subject,
      query,
      evidence,
      claims,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      raw_saved,
    };
  });