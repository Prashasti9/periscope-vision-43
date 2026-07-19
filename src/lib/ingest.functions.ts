import { createServerFn } from "@tanstack/react-start";

/* Port of ingest.py — fetches public signals from GitHub, Hacker News,
   arXiv, and YC (yc-oss mirror), builds people-candidate rollups, and
   upserts everything into Supabase. Runs on the server so browsers don't
   hit CORS-hostile APIs directly. */

const GITHUB_URL = "https://api.github.com/search/repositories";
const HN_URL = "https://hn.algolia.com/api/v1/search_by_date";
const ARXIV_URL = "https://export.arxiv.org/api/query";
const YC_URL = "https://yc-oss.github.io/api/companies/all.json";

type Signal = {
  signal_id: string;
  source: string;
  person_or_handle: string;
  company: string;
  text: string;
  url: string;
  date: string;
  reliability: number;
};

type PersonCandidate = {
  identity_key: string;
  person_or_handle: string;
  source_count: number;
  sources: string;
  companies: string;
  signal_count: number;
};

function cleanText(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
function isoDate(v: string | undefined | null): string {
  return v ? v.slice(0, 10) : "";
}
function makeSignal(
  source: string,
  person: string,
  company: string,
  text: string,
  url: string,
  date: string,
  reliability: number,
  key: string,
): Signal {
  return {
    signal_id: `${source}:${key}`,
    source,
    person_or_handle: cleanText(person),
    company: cleanText(company),
    text: cleanText(text),
    url: url || "",
    date: isoDate(date),
    reliability,
  };
}

async function httpGet(url: string, params: Record<string, string | number>, headers: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const full = qs ? `${url}?${qs}` : url;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(full, {
      headers: { "User-Agent": "vc-signal-demo/1.0", Accept: "application/json", ...headers },
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(30_000, 2 ** attempt * 1000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    return res;
  }
  throw new Error(`Request retries exhausted: ${url}`);
}

async function fetchGithub(since: string, limit: number, token?: string): Promise<Signal[]> {
  const rows: Signal[] = [];
  const seen = new Set<number>();
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  for (const topic of ["llm", "ai-agents", "rag", "inference"]) {
    try {
      const res = await httpGet(
        GITHUB_URL,
        { q: `topic:${topic} created:>=${since} stars:>10`, sort: "stars", order: "desc", per_page: Math.min(limit, 100) },
        auth,
      );
      const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
      for (const repo of data.items ?? []) {
        const id = repo.id as number;
        if (seen.has(id)) continue;
        seen.add(id);
        const owner = (repo.owner as { login?: string } | null) ?? {};
        const text = `${repo.full_name ?? ""}: ${repo.description ?? "No description"} | ${repo.stargazers_count ?? 0} stars, ${repo.forks_count ?? 0} forks.`;
        rows.push(makeSignal("github", owner.login ?? "", (repo.name as string) ?? "", text, (repo.html_url as string) ?? "", (repo.created_at as string) ?? "", 0.9, String(id)));
      }
    } catch (e) {
      console.warn(`github topic ${topic} failed:`, e);
    }
  }
  return rows;
}

async function fetchHN(sinceEpoch: number, limit: number): Promise<Signal[]> {
  const rows: Signal[] = [];
  const seen = new Set<string>();
  for (const kw of ["AI", "LLM", "agent", "RAG"]) {
    try {
      const res = await httpGet(HN_URL, {
        query: `Show HN ${kw}`,
        tags: "story",
        numericFilters: `created_at_i>${sinceEpoch}`,
        hitsPerPage: Math.min(limit, 100),
      });
      const data = (await res.json()) as { hits?: Array<Record<string, unknown>> };
      for (const hit of data.hits ?? []) {
        const objectId = String(hit.objectID ?? "");
        const title = cleanText(hit.title);
        if (!objectId || seen.has(objectId) || !title.toLowerCase().includes("show hn")) continue;
        seen.add(objectId);
        const url = (hit.url as string) || `https://news.ycombinator.com/item?id=${objectId}`;
        const text = `${title} | ${hit.points ?? 0} points.`;
        rows.push(makeSignal("hacker_news", (hit.author as string) ?? "", "", text, url, (hit.created_at as string) ?? "", 0.8, objectId));
      }
    } catch (e) {
      console.warn(`hn kw ${kw} failed:`, e);
    }
  }
  return rows;
}

async function fetchArxiv(since: Date, limit: number): Promise<Signal[]> {
  const res = await httpGet(
    ARXIV_URL,
    { search_query: "cat:cs.AI OR cat:cs.LG", start: 0, max_results: limit, sortBy: "submittedDate", sortOrder: "descending" },
    { Accept: "application/atom+xml" },
  );
  const xml = await res.text();
  const rows: Signal[] = [];
  // Minimal regex-based Atom parsing (no XML parser in the Worker runtime).
  const entryRe = /<entry\b[\s\S]*?<\/entry>/g;
  const tag = (block: string, name: string) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
    return m ? m[1].trim() : "";
  };
  for (const m of xml.matchAll(entryRe)) {
    const block = m[0];
    const published = tag(block, "published");
    if (!published) continue;
    const pubDate = new Date(published);
    if (isNaN(pubDate.getTime()) || pubDate < since) continue;
    const authorBlock = block.match(/<author>[\s\S]*?<\/author>/)?.[0] ?? "";
    const author = tag(authorBlock, "name");
    const title = cleanText(tag(block, "title"));
    const idRaw = tag(block, "id");
    const arxivId = idRaw.split("/").pop() ?? idRaw;
    rows.push(makeSignal("arxiv", author, "", title, `https://arxiv.org/abs/${arxivId}`, published, 0.95, arxivId));
  }
  return rows;
}

function recentBatches(companies: Array<Record<string, unknown>>, count = 4): Set<string> {
  const batches = new Set<string>();
  for (const c of companies) {
    const b = cleanText(c.batch);
    if (b) batches.add(b);
  }
  const batchKey = (b: string): [number, number] => {
    const m = /^([SW])([0-9]{2})$/.exec(b);
    if (!m) return [-1, -1];
    return [parseInt(m[2], 10), m[1] === "S" ? 1 : 0];
  };
  return new Set(
    [...batches]
      .sort((a, b) => {
        const ka = batchKey(a), kb = batchKey(b);
        return kb[0] - ka[0] || kb[1] - ka[1];
      })
      .slice(0, count),
  );
}

async function fetchYC(): Promise<Signal[]> {
  const res = await httpGet(YC_URL, {});
  const companies = (await res.json()) as Array<Record<string, unknown>>;
  const batches = recentBatches(companies);
  const rows: Signal[] = [];
  for (const company of companies) {
    if (!batches.has(cleanText(company.batch))) continue;
    let founders = company.founders as unknown;
    if (typeof founders === "string") founders = [founders];
    if (!Array.isArray(founders)) founders = [];
    const names: string[] = (founders as unknown[]).map((f) =>
      f && typeof f === "object" ? ((f as { name?: string }).name ?? "") : String(f ?? ""),
    );
    if (names.length === 0) names.push("");
    const name = cleanText(company.name);
    const text = `YC ${company.batch ?? ""}: ${company.one_liner ?? company.long_description ?? ""}`;
    const url = `https://www.ycombinator.com/companies/${company.slug ?? ""}`;
    names.forEach((founder, i) => {
      rows.push(makeSignal("yc", founder, name, text, url, "", 0.9, `${company.id ?? name}:${i}`));
    });
  }
  return rows;
}

function identityKey(person: string): string {
  return cleanText(person).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildPeople(signals: Signal[]): { people: PersonCandidate[]; duplicates: number } {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!s.person_or_handle.trim()) continue;
    const key = identityKey(s.person_or_handle);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const people: PersonCandidate[] = [];
  let usable = 0;
  for (const [key, rows] of groups) {
    usable += rows.length;
    const sources = new Set(rows.map((r) => r.source));
    const companies = new Set(rows.map((r) => r.company).filter(Boolean));
    people.push({
      identity_key: key,
      person_or_handle: rows[0].person_or_handle,
      source_count: sources.size,
      sources: [...sources].sort().join(";"),
      companies: [...companies].sort().join(";"),
      signal_count: rows.length,
    });
  }
  people.sort((a, b) => b.source_count - a.source_count || b.signal_count - a.signal_count);
  return { people, duplicates: usable - people.length };
}

export const runIngest = createServerFn({ method: "POST" })
  .inputValidator((input: { days?: number; limit?: number } | undefined) => ({
    days: input?.days ?? 90,
    limit: input?.limit ?? 30,
  }))
  .handler(async ({ data }) => {
    const now = new Date();
    const since = new Date(now.getTime() - data.days * 86400_000);
    const sinceDate = since.toISOString().slice(0, 10);
    const sinceEpoch = Math.floor(since.getTime() / 1000);
    const token = process.env.GITHUB_TOKEN;

    const sourceCounts: Record<string, number> = {};
    const collectors: Array<[string, () => Promise<Signal[]>]> = [
      ["github", () => fetchGithub(sinceDate, data.limit, token)],
      ["hacker_news", () => fetchHN(sinceEpoch, data.limit)],
      ["arxiv", () => fetchArxiv(since, data.limit)],
      ["yc", () => fetchYC()],
    ];
    const allRows: Signal[] = [];
    for (const [name, collect] of collectors) {
      try {
        const rows = await collect();
        allRows.push(...rows);
        sourceCounts[name] = rows.length;
      } catch (e) {
        sourceCounts[name] = 0;
        console.warn(`${name} skipped:`, e);
      }
    }

    const { people, duplicates } = buildPeople(allRows);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (allRows.length > 0) {
      // Upsert in chunks to avoid oversized requests.
      for (let i = 0; i < allRows.length; i += 500) {
        const chunk = allRows.slice(i, i + 500);
        const { error } = await supabaseAdmin.from("signals").upsert(chunk, { onConflict: "signal_id" });
        if (error) throw error;
      }
    }
    if (people.length > 0) {
      for (let i = 0; i < people.length; i += 500) {
        const chunk = people.slice(i, i + 500);
        const { error } = await supabaseAdmin
          .from("people_candidates")
          .upsert(chunk.map((p) => ({ ...p, updated_at: new Date().toISOString() })), { onConflict: "identity_key" });
        if (error) throw error;
      }
    }

    return {
      sourceCounts,
      duplicates,
      signalCount: allRows.length,
      peopleCount: people.length,
      ranAt: now.toISOString(),
    };
  });