import { createServerFn } from "@tanstack/react-start";

/* enrichCandidate — pulls GitHub profile + Tavily web evidence for a
   people_candidates row so the scorer has real facts to cite. Results
   are cached (github_profile as a signals row; tavily hits as real_signals). */

export type EnrichedSignal = {
  signal_id: string;
  source: string;
  text: string;
  url: string;
  date: string;
  reliability: number;
  company?: string;
};

export type EnrichedWebEvidence = {
  idx: string;
  title: string;
  url: string;
  content: string;
  score: number;
  reliability: number;
  date: string;
};

export type EnrichedGithubProfile = {
  login: string;
  name: string | null;
  bio: string | null;
  blog: string | null;
  company: string | null;
  followers: number;
  public_repos: number;
  created_at: string;
  html_url: string;
};

export type EnrichmentResult = {
  identity_key: string;
  person_or_handle: string;
  companies: string;
  cold_start: boolean;
  signals: EnrichedSignal[];
  github_profile: EnrichedGithubProfile | null;
  web_evidence: EnrichedWebEvidence[];
  avg_reliability: number;
  evidence_count: number;
};

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "vc-signal-demo/1.0",
        Accept: "application/json",
        ...headers,
      },
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(30_000, 2 ** attempt * 1000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    return res;
  }
  throw new Error(`Request retries exhausted: ${url}`);
}

export const enrichCandidate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { identityKey?: unknown };
    if (typeof v?.identityKey !== "string" || !v.identityKey)
      throw new Error("identityKey required");
    return { identityKey: v.identityKey };
  })
  .handler(async ({ data }): Promise<EnrichmentResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: candidate, error: cErr } = await supabaseAdmin
      .from("people_candidates")
      .select("*")
      .eq("identity_key", data.identityKey)
      .maybeSingle();
    if (cErr) throw new Error(`DB: ${cErr.message}`);
    if (!candidate) throw new Error("Candidate not found");

    // Load existing signals
    const { data: rawSignals } = await supabaseAdmin
      .from("signals")
      .select("*")
      .ilike("person_or_handle", candidate.person_or_handle);
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const mySignals = (rawSignals ?? []).filter(
      (s) => normalize(s.person_or_handle) === data.identityKey,
    );

    const sourceSet = new Set(mySignals.map((s) => s.source));
    const hasGithub = sourceSet.has("github");
    const hasBuilderSource =
      hasGithub ||
      sourceSet.has("hacker_news") ||
      sourceSet.has("arxiv") ||
      sourceSet.has("yc");
    const coldStart = !hasBuilderSource;

    // ---- GitHub profile ----
    let githubProfile: EnrichedGithubProfile | null = null;
    const cachedProfileSignal = mySignals.find(
      (s) => s.source === "github_profile",
    );
    if (cachedProfileSignal) {
      try {
        githubProfile = JSON.parse(cachedProfileSignal.text || "{}");
      } catch {
        githubProfile = null;
      }
    } else if (hasGithub) {
      // Derive login from a github signal — signal_id is `github:<repoId>`,
      // but person_or_handle is the login used by the ingest step.
      const login = candidate.person_or_handle.trim();
      if (login) {
        try {
          const token = process.env.GITHUB_TOKEN;
          const res = await httpGet(
            `https://api.github.com/users/${encodeURIComponent(login)}`,
            token ? { Authorization: `Bearer ${token}` } : {},
          );
          if (res.ok) {
            const j = (await res.json()) as Record<string, unknown>;
            githubProfile = {
              login: String(j.login ?? login),
              name: (j.name as string) ?? null,
              bio: (j.bio as string) ?? null,
              blog: (j.blog as string) ?? null,
              company: (j.company as string) ?? null,
              followers: Number(j.followers ?? 0),
              public_repos: Number(j.public_repos ?? 0),
              created_at: String(j.created_at ?? ""),
              html_url: String(j.html_url ?? `https://github.com/${login}`),
            };
            // Cache as a signals row
            await supabaseAdmin.from("signals").upsert(
              {
                signal_id: `github_profile:${login}`,
                source: "github_profile",
                person_or_handle: login,
                company: githubProfile.company ?? "",
                text: JSON.stringify(githubProfile),
                url: githubProfile.html_url,
                date: githubProfile.created_at.slice(0, 10),
                reliability: 0.95,
              },
              { onConflict: "signal_id" },
            );
          }
        } catch (e) {
          console.warn("github profile fetch failed:", e);
        }
      }
    }

    // ---- Tavily web evidence (always run; primary path for cold-start) ----
    const firstCompany =
      (candidate.companies ?? "")
        .split(/[,;|]/)
        .map((x) => x.trim())
        .filter(Boolean)[0] ?? "";
    const query = `${candidate.person_or_handle} ${firstCompany} founder`
      .replace(/\s+/g, " ")
      .trim();

    let webEvidence: EnrichedWebEvidence[] = [];
    const tavilyKey = process.env.TAVILY_API_KEY;
    const today = new Date().toISOString().slice(0, 10);

    // Check cached real_signals for this identity_key first
    const { data: cachedReal } = await supabaseAdmin
      .from("real_signals")
      .select("*")
      .eq("subject", data.identityKey)
      .order("created_at", { ascending: false })
      .limit(20);

    const fresh = (cachedReal ?? []).filter((r) => r.date === today);

    if (fresh.length > 0) {
      webEvidence = fresh.map((r, i) => ({
        idx: `W-${i}`,
        title: r.title,
        url: r.url,
        content: (r.content ?? "").slice(0, 3000),
        score: Number(r.score) || 0,
        reliability: Number(r.reliability) || 0.7,
        date: r.date,
      }));
    } else if (tavilyKey) {
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
            max_results: coldStart ? 8 : 6,
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
          webEvidence = (tavJson.results ?? []).map((r, i) => ({
            idx: `W-${i}`,
            title: r.title ?? "",
            url: r.url ?? "",
            content: (r.content ?? r.raw_content ?? "").slice(0, 3000),
            score: typeof r.score === "number" ? r.score : 0,
            reliability: 0.7,
            date: today,
          }));
          if (webEvidence.length) {
            await supabaseAdmin.from("real_signals").insert(
              webEvidence.map((e) => ({
                source: "tavily",
                subject: data.identityKey,
                query,
                title: e.title,
                url: e.url,
                content: e.content,
                score: e.score,
                reliability: e.reliability,
                date: today,
              })),
            );
          }
        }
      } catch (e) {
        console.warn("tavily enrichment failed:", e);
      }
    }

    // Build combined signals list (raw signals + github_profile as a signal)
    const signals: EnrichedSignal[] = mySignals
      .filter((s) => s.source !== "github_profile")
      .map((s) => ({
        signal_id: s.signal_id,
        source: s.source,
        text: s.text,
        url: s.url,
        date: s.date,
        reliability: Number(s.reliability) || 0,
        company: s.company,
      }));
    if (githubProfile) {
      signals.push({
        signal_id: `github_profile:${githubProfile.login}`,
        source: "github_profile",
        text: `GitHub profile — followers=${githubProfile.followers}, public_repos=${githubProfile.public_repos}, created=${githubProfile.created_at.slice(0, 10)}, bio="${githubProfile.bio ?? ""}", company="${githubProfile.company ?? ""}", blog="${githubProfile.blog ?? ""}"`,
        url: githubProfile.html_url,
        date: githubProfile.created_at.slice(0, 10),
        reliability: 0.95,
      });
    }

    const evidenceCount = signals.length + webEvidence.length;
    const relSum =
      signals.reduce((a, s) => a + (s.reliability || 0), 0) +
      webEvidence.reduce((a, w) => a + (w.reliability || 0), 0);
    const avgReliability = evidenceCount > 0 ? relSum / evidenceCount : 0;

    return {
      identity_key: data.identityKey,
      person_or_handle: candidate.person_or_handle,
      companies: candidate.companies ?? "",
      cold_start: coldStart,
      signals,
      github_profile: githubProfile,
      web_evidence: webEvidence,
      avg_reliability: avgReliability,
      evidence_count: evidenceCount,
    };
  });