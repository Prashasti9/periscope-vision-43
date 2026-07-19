import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { askAI } from "@/lib/periscope-ai.functions";
import { runIngest } from "@/lib/ingest.functions";
import { getFounders, getPeopleCandidates, getSignals } from "@/lib/data.functions";
import {
  generateMemo,
  scoreCandidate,
  screenCandidate,
  type CandidateScore,
} from "@/lib/openai.functions";
import { deepDiligence, type DiligenceResult } from "@/lib/diligence.functions";
import { submitApplication, convergeCandidate } from "@/lib/application.functions";
import { scoreFounder } from "@/lib/openai.functions";
import { toDisplayAxes } from "@/lib/adapters";

export const Route = createFileRoute("/")({
  component: Periscope,
});

/* ============================================================
   PERISCOPE — The VC brain that sees founders before they surface
   Design tokens: dossier-meets-terminal.
   ============================================================ */

const C = {
  ink: "#1A2B33",
  inkSoft: "#5C6F78",
  paper: "#F7F8F7",
  petrol: "#12242E",
  card: "#FFFFFF",
  line: "#E3E8E6",
  sea: "#0E7C66",
  seaSoft: "#E3F2EE",
  amber: "#B26A0E",
  amberSoft: "#F8EEDD",
  flag: "#B3382C",
  flagSoft: "#F9E8E5",
  cool: "#33628C",
  coolSoft: "#E7EEF5",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
  body: "'IBM Plex Sans', system-ui, sans-serif",
  disp: "'Fraunces', Georgia, serif",
};

/* -------- Types (mirror Supabase row shape) -------- */
type Axis = {
  score: number | null;
  rating?: string;
  trend: string | null;
  note: string;
};
type Founder = {
  id: string;
  name: string;
  company: string;
  oneLiner: string;
  track: "inbound" | "outbound";
  stage: string;
  geo: string;
  sector: string;
  accelerator: string | null;
  priorVC: boolean;
  tags: string[];
  founderScore: {
    value: number;
    low: number;
    high: number;
    trend: string;
    coldStart: boolean;
    history?: string;
  };
  axes: { founder: Axis; market: Axis; ideaVsMarket: Axis };
  signals: { id: string; src: string; ts: string; text: string; conf: number }[];
  claims: { claim: string; trust: number; evidence: string; flag: string | null }[];
  gaps: string[];
  momentum: number[];
};

const DEFAULT_THESIS = {
  sectors: [] as string[],
  stages: [] as string[],
  geos: [] as string[],
  check: "$100K",
  ownership: "3-5%",
  risk: "High — pre-track-record OK",
};

const CHECK_OPTIONS = ["$50K", "$100K", "$150K", "$250K+"];
const OWNERSHIP_OPTIONS = ["1-3%", "3-5%", "5-10%"];
const RISK_OPTIONS = [
  "High — pre-track-record OK",
  "Moderate — prefer track record",
];

function thesisMatches(f: Founder, thesis: typeof DEFAULT_THESIS) {
  if (thesis.sectors.length > 0 && !thesis.sectors.includes(f.sector)) return false;
  if (thesis.stages.length > 0 && !thesis.stages.includes(f.stage)) return false;
  if (thesis.geos.length > 0 && !thesis.geos.includes(f.geo)) return false;
  return true;
}

function thesisFit(f: Founder, thesis: typeof DEFAULT_THESIS) {
  let fit = 0;
  const why: string[] = [];
  if (thesis.sectors.length === 0 || thesis.sectors.includes(f.sector)) {
    fit += 40;
    why.push(`sector ∈ thesis (${f.sector})`);
  } else why.push(`sector outside thesis (${f.sector})`);
  if (thesis.stages.length === 0 || thesis.stages.includes(f.stage)) {
    fit += 30;
    why.push(`stage ∈ thesis (${f.stage})`);
  }
  const risky = f.founderScore.coldStart;
  if (risky && thesis.risk.startsWith("High")) {
    fit += 15;
    why.push("cold-start allowed by risk appetite");
  } else if (risky) {
    why.push("cold-start penalized by risk appetite");
  } else fit += 10;
  fit += Math.round((f.founderScore.value / 1000) * 15);
  const traction = f.founderScore.value;
  if (
    (thesis.check === "$50K" && traction < 700) ||
    (thesis.check === "$100K" && traction >= 600 && traction < 850) ||
    (thesis.check === "$150K" && traction >= 750 && traction < 900) ||
    (thesis.check === "$250K+" && traction >= 850)
  ) {
    fit += 3;
    why.push(`traction aligns with ${thesis.check} check`);
  }
  return { fit, why };
}

/* -------- Primitives -------- */
function Chip({
  tone = "cool",
  children,
}: {
  tone?: "sea" | "amber" | "flag" | "cool" | "ink";
  children: React.ReactNode;
}) {
  const map: Record<string, [string, string]> = {
    sea: [C.seaSoft, C.sea],
    amber: [C.amberSoft, C.amber],
    flag: [C.flagSoft, C.flag],
    cool: [C.coolSoft, C.cool],
    ink: ["#E9EDEC", C.inkSoft],
  };
  const [bg, fg] = map[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: bg,
        color: fg,
        fontFamily: C.mono,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        marginRight: 4,
      }}
    >
      {children}
    </span>
  );
}

function TrustDot({ v }: { v: number }) {
  const tone = v >= 0.75 ? C.sea : v >= 0.5 ? C.amber : C.flag;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: C.mono,
        fontSize: 11,
        color: tone,
        fontWeight: 500,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: tone,
          display: "inline-block",
        }}
      />
      {Math.round(v * 100)}%
    </span>
  );
}

function Trend({ t }: { t: string | null | undefined }) {
  if (!t) return null;
  const arrow = t === "improving" ? "▲" : t === "declining" ? "▼" : "▶";
  const color = t === "improving" ? C.sea : t === "declining" ? C.flag : C.inkSoft;
  return (
    <span style={{ fontFamily: C.mono, fontSize: 10, color, marginLeft: 6 }}>
      {arrow} {t}
    </span>
  );
}

function Spark({ data, w = 120, h = 30 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * w},${
          h - ((v - min) / (max - min || 1)) * (h - 4) - 2
        }`,
    )
    .join(" ");
  const up = data[data.length - 1] >= data[0];
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline
        points={pts}
        fill="none"
        stroke={up ? C.sea : C.flag}
        strokeWidth={1.5}
      />
    </svg>
  );
}

function ScoreBand({ fs }: { fs: Founder["founderScore"] }) {
  const pct = (v: number) => `${(v / 1000) * 100}%`;
  return (
    <div style={{ fontFamily: C.body }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: C.disp, fontSize: 34, color: C.ink, fontWeight: 600 }}>
          {fs.value}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
          [{fs.low}–{fs.high}] / 1000
        </span>
        <Trend t={fs.trend} />
        {fs.coldStart && (
          <span style={{ marginLeft: 4 }}>
            <Chip tone="amber">cold-start · wide interval by design</Chip>
          </span>
        )}
      </div>
      <div
        style={{
          position: "relative",
          marginTop: 10,
          height: 8,
          background: "#EDF1F0",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: pct(fs.low),
            width: `calc(${pct(fs.high)} - ${pct(fs.low)})`,
            top: 0,
            bottom: 0,
            background: C.seaSoft,
            borderLeft: `2px solid ${C.sea}`,
            borderRight: `2px solid ${C.sea}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: pct(fs.value),
            top: -2,
            bottom: -2,
            width: 2,
            background: C.ink,
          }}
        />
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: C.mono,
          fontSize: 10,
          color: C.inkSoft,
          fontStyle: "italic",
        }}
      >
        A score is an interval, not a number. The band is what we honestly know.
      </div>
    </div>
  );
}

/* -------- Deep diligence tab -------- */
function DiligenceView() {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<DiligenceResult | null>(null);
  const runDiligence = useServerFn(deepDiligence);

  const run = async () => {
    if (!name.trim()) {
      setErr("Enter a founder name.");
      return;
    }
    setBusy(true);
    setErr("");
    setResult(null);
    try {
      const r = await runDiligence({ data: { name, company } });
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Diligence failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ fontFamily: C.disp, fontSize: 28, margin: 0, fontWeight: 600 }}>
        Deep diligence
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 6, marginBottom: 18 }}>
        Live web search (Tavily) → evidence saved to <code>real_signals</code> → GPT-4o extracts
        claims and scores each 0–1 against the retrieved sources. Nothing here is presented as
        confirmed fact — only <em>retrieved web evidence</em>.
      </p>

      <div
        style={{
          display: "flex",
          gap: 10,
          background: C.card,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          padding: 14,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Founder name (required)"
          style={{
            flex: "1 1 200px",
            padding: "9px 12px",
            fontSize: 13,
            border: `1px solid ${C.line}`,
            borderRadius: 8,
            fontFamily: C.body,
          }}
        />
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company (optional)"
          style={{
            flex: "1 1 200px",
            padding: "9px 12px",
            fontSize: 13,
            border: `1px solid ${C.line}`,
            borderRadius: 8,
            fontFamily: C.body,
          }}
        />
        <button
          onClick={run}
          disabled={busy}
          style={{
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 8,
            border: "none",
            background: busy ? C.inkSoft : C.ink,
            color: "#fff",
            cursor: busy ? "wait" : "pointer",
            fontFamily: C.body,
          }}
        >
          {busy ? "Searching web…" : "Run diligence"}
        </button>
      </div>

      {err && (
        <div
          style={{
            background: C.flagSoft,
            color: C.flag,
            border: `1px solid ${C.flag}`,
            borderRadius: 8,
            padding: 10,
            fontSize: 12,
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}

      {busy && (
        <div style={{ fontFamily: C.mono, fontSize: 12, color: C.inkSoft, fontStyle: "italic" }}>
          Retrieving web evidence, saving to real_signals, then extracting claims…
        </div>
      )}

      {result && (
        <div>
          <div
            style={{
              fontFamily: C.mono,
              fontSize: 10,
              color: C.inkSoft,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 6,
            }}
          >
            RETRIEVED WEB EVIDENCE — {result.evidence.length} results ·{" "}
            {result.raw_saved} saved to real_signals · never presented as confirmed fact
          </div>

          {result.summary && (
            <div
              style={{
                background: C.coolSoft,
                color: C.cool,
                borderRadius: 8,
                padding: 10,
                fontSize: 12,
                marginBottom: 14,
                fontFamily: C.body,
              }}
            >
              {result.summary}
            </div>
          )}

          <div
            style={{
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              padding: 18,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                color: C.inkSoft,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 10,
              }}
            >
              CLAIMS — each with Trust Score & source · contradictions flagged in red
            </div>
            {result.claims.length === 0 && (
              <div style={{ fontSize: 12, color: C.inkSoft, fontStyle: "italic" }}>
                No concrete claims extracted from the retrieved evidence.
              </div>
            )}
            {result.claims.map((c, i) => (
              <div
                key={i}
                style={{
                  borderLeft: `3px solid ${
                    c.contradiction ? C.flag : c.trust >= 0.75 ? C.sea : C.amber
                  }`,
                  background: c.contradiction ? C.flagSoft : "transparent",
                  padding: "10px 12px",
                  marginBottom: 8,
                  borderRadius: c.contradiction ? 8 : 0,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: c.contradiction ? C.flag : C.ink,
                    }}
                  >
                    {c.claim}
                  </span>
                  <TrustDot v={c.trust} />
                  {c.contradiction && <Chip tone="flag">⚠ contradicted</Chip>}
                  {c.flag && !c.contradiction && <Chip tone="amber">⚠ {c.flag}</Chip>}
                </div>
                {c.evidence && (
                  <div
                    style={{
                      fontSize: 11,
                      color: C.inkSoft,
                      marginTop: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    {c.evidence}
                  </div>
                )}
                {c.source_url && (
                  <a
                    href={c.source_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-block",
                      marginTop: 6,
                      fontFamily: C.mono,
                      fontSize: 11,
                      color: C.sea,
                      textDecoration: "none",
                      wordBreak: "break-all",
                    }}
                  >
                    {c.source_url}
                  </a>
                )}
              </div>
            ))}
          </div>

          <div
            style={{
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              padding: 18,
            }}
          >
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                color: C.inkSoft,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 10,
              }}
            >
              RAW RETRIEVED SOURCES — labeled retrieved web evidence, not confirmed fact
            </div>
            {result.evidence.map((e, i) => (
              <a
                key={i}
                href={e.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "block",
                  padding: "10px 12px",
                  borderBottom: `1px solid ${C.line}`,
                  color: C.ink,
                  textDecoration: "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 3,
                  }}
                >
                  <Chip tone="cool">tavily</Chip>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    {e.title || e.url}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontFamily: C.mono,
                      fontSize: 10,
                      color: C.inkSoft,
                    }}
                  >
                    score {e.score.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: C.inkSoft, lineHeight: 1.5 }}>
                  {e.content.slice(0, 240)}
                  {e.content.length > 240 ? "…" : ""}
                </div>
                <div
                  style={{
                    fontFamily: C.mono,
                    fontSize: 10,
                    color: C.sea,
                    marginTop: 4,
                    wordBreak: "break-all",
                  }}
                >
                  {e.url}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Evidence({ s }: { s: Founder["signals"][number] }) {
  return (
    <div
      style={{
        borderLeft: `2px solid ${C.line}`,
        padding: "6px 12px",
        marginBottom: 6,
        fontFamily: C.body,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: C.mono,
          fontSize: 10,
          color: C.inkSoft,
        }}
      >
        <span style={{ color: C.ink, fontWeight: 500 }}>{s.id}</span>
        <Chip tone="ink">{s.src}</Chip>
        <span>{s.ts}</span>
        <span style={{ marginLeft: "auto" }}>
          <TrustDot v={s.conf} />
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.ink, marginTop: 3 }}>{s.text}</div>
    </div>
  );
}

/* -------- Row → Founder mapping -------- */
function rowToFounder(r: any): Founder {
  // Normalize axes through the single adapter so legacy rows that stored a
  // raw CandidateScore (snake_case idea_vs_market, no trend field) render
  // correctly instead of TypeError'ing on ax.trend and blanking the page.
  const axes = toDisplayAxes(r.axes, `founder:${r?.id ?? "(unknown)"}`);
  return {
    id: r.id,
    name: r.name,
    company: r.company,
    oneLiner: r.one_liner,
    track: r.track,
    stage: r.stage,
    geo: r.geo,
    sector: r.sector,
    accelerator: r.accelerator,
    priorVC: r.prior_vc,
    tags: r.tags ?? [],
    founderScore: r.founder_score,
    axes: axes as unknown as Founder["axes"],
    signals: r.signals ?? [],
    claims: r.claims ?? [],
    gaps: r.gaps ?? [],
    momentum: r.momentum ?? [],
  };
}

/* -------- Main app -------- */
function Periscope() {
  const [founders, setFounders] = useState<Founder[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("pipeline");
  const [thesis, setThesis] = useState(DEFAULT_THESIS);
  const [selected, setSelected] = useState<Founder | null>(null);
  const [query, setQuery] = useState("");
  const [queryResult, setQueryResult] = useState<
    | null
    | { error?: string; interpretation?: string; matches: { id: string; reason: string }[] }
  >(null);
  const [queryBusy, setQueryBusy] = useState(false);
  const [memo, setMemo] = useState<{ founder: Founder; text: string } | null>(null);
  const [memoBusy, setMemoBusy] = useState(false);
  const [outreach, setOutreach] = useState<{ founder: Founder; text: string } | null>(null);
  const [outreachBusy, setOutreachBusy] = useState(false);

  const ai = useServerFn(askAI);
  const memoFn = useServerFn(generateMemo);
  const applyFn = useServerFn(submitApplication);
  const scoreFounderFn = useServerFn(scoreFounder);
  const getFoundersFn = useServerFn(getFounders);
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let data: any[] = [];
      try {
        data = await getFoundersFn();
      } catch (error) {
        if (cancelled) return;
        console.error(error);
        setLoading(false);
        return;
      }
      if (cancelled) return;
      const list = (data ?? []).map(rowToFounder);
      setFounders(list);
      if (list[1]) setSelected(list[1]);
      else if (list[0]) setSelected(list[0]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [getFoundersFn]);

  const ranked = useMemo(
    () =>
      founders
        .filter((f) => thesisMatches(f, thesis))
        .map((f) => ({ f, ...thesisFit(f, thesis) }))
        .sort((a, b) => b.fit - a.fit),
    [founders, thesis],
  );

  const runQuery = useCallback(async () => {
    if (!query.trim()) return;
    setQueryBusy(true);
    setQueryResult(null);
    const compact = founders.map((f) => ({
      id: f.id,
      name: f.name,
      company: f.company,
      sector: f.sector,
      geo: f.geo,
      stage: f.stage,
      accelerator: f.accelerator,
      priorVC: f.priorVC,
      tags: f.tags,
      oneLiner: f.oneLiner,
      founderScore: f.founderScore.value,
      axes: {
        founder: f.axes?.founder?.score ?? null,
        market: f.axes?.market?.score ?? null,
        ideaVsMarket: f.axes?.ideaVsMarket?.score ?? null,
      },
    }));
    try {
      const raw = await ai({
        data: {
          prompt: `Database: ${JSON.stringify(compact)}\n\nInvestor query: "${query}"\n\nReturn ONLY JSON, no prose, no backticks: {"matches":[{"id":"...","reason":"one sentence citing the specific attributes that matched"}],"interpretation":"one sentence restating the query as structured criteria"}`,
          system:
            "You are the multi-attribute reasoning layer of a VC sourcing system. Resolve compound natural-language queries against founder records in one pass. Be strict: only include genuine matches.",
        },
      });
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      setQueryResult(parsed);
    } catch {
      setQueryResult({
        error: "Query engine unreachable — check connection and retry.",
        matches: [],
      });
    }
    setQueryBusy(false);
  }, [query, founders, ai]);

  const genMemo = useCallback(
    async (f: Founder) => {
      setMemoBusy(true);
      setMemo(null);
      setView("memo");
      try {
        const { text } = await memoFn({ data: { founderId: f.id } });
        setMemo({ founder: f, text });
      } catch (e) {
        setMemo({
          founder: f,
          text:
            "Memo engine unreachable — " +
            (e instanceof Error ? e.message : String(e)) +
            "\n\nAll underlying evidence remains available in the dossier tab.",
        });
      }
      setMemoBusy(false);
    },
    [memoFn],
  );

  const activate = useCallback(
    async (f: Founder) => {
      setOutreachBusy(true);
      setOutreach(null);
      try {
        const text = await ai({
          data: {
            prompt: `Founder: ${f.name}, signals: ${JSON.stringify(f.signals)}. Draft a 90-word cold outreach email from an investor. Reference the SPECIFIC public work (repo, paper) that triggered this. Goal: get them to submit an application (deck + company name). Tone: peer-to-peer, zero flattery-spam. Plain text.`,
            system:
              "You write outreach that converts builders into applicants. Cold outreach, not cold investment.",
          },
        });
        setOutreach({ founder: f, text });
      } catch {
        setOutreach({ founder: f, text: "Draft engine unreachable — retry." });
      }
      setOutreachBusy(false);
    },
    [ai],
  );

  const NavBtn = ({ id, label }: { id: string; label: string }) => (
    <button
      onClick={() => setView(id)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "9px 14px",
        border: "none",
        cursor: "pointer",
        background: view === id ? C.card : "transparent",
        color: view === id ? C.ink : "#B9C9C4",
        fontFamily: C.body,
        fontSize: 13,
        fontWeight: view === id ? 600 : 400,
        borderRadius: 8,
        marginBottom: 2,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.paper,
        color: C.ink,
        fontFamily: C.body,
      }}
    >
      <style>{`*{box-sizing:border-box} button:focus-visible{outline:2px solid ${C.sea};outline-offset:2px}`}</style>

      {/* Top bar */}
      <div
        style={{
          background: C.petrol,
          color: "#fff",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          gap: 24,
        }}
      >
        <div>
          <div style={{ fontFamily: C.disp, fontSize: 22, fontWeight: 600, lineHeight: 1 }}>
            Periscope
          </div>
          <div
            style={{
              fontFamily: C.mono,
              fontSize: 10,
              color: "#8FAFA4",
              letterSpacing: 0.5,
              marginTop: 2,
              textTransform: "uppercase",
            }}
          >
            the VC brain · sees founders before they surface
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: 1, alignItems: "center" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runQuery()}
            placeholder={
              'Ask anything — "technical founder, Berlin, AI infra, enterprise traction, no prior VC, top-tier accelerator"'
            }
            style={{
              flex: 1,
              padding: "10px 14px",
              borderRadius: 8,
              border: "none",
              fontFamily: C.mono,
              fontSize: 12,
              background: "#1C3444",
              color: "#fff",
            }}
          />
          <button
            onClick={runQuery}
            disabled={queryBusy}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              background: C.sea,
              color: "#fff",
              fontFamily: C.body,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {queryBusy ? "Reasoning…" : "Search"}
          </button>
          <button
            onClick={() => setApplyOpen(true)}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: `1px solid ${C.sea}`,
              background: "transparent",
              color: "#fff",
              fontFamily: C.body,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Apply
          </button>
        </div>
      </div>

      {applyOpen && (
        <ApplyModal
          onClose={() => setApplyOpen(false)}
          submit={async (payload) => {
            const res = await applyFn({ data: payload });
            // Refresh founders list so the new inbound row appears.
            try {
              const data = await getFoundersFn();
              setFounders((data ?? []).map(rowToFounder));
            } catch (e) {
              console.error(e);
            }
            // Fire-and-forget scoring; UI will pick up updates on next load.
            scoreFounderFn({ data: { founderId: res.id } }).catch(() => {});
            return res;
          }}
        />
      )}

      {queryResult && (
        <div style={{ padding: "12px 24px", background: "#132A38", color: "#DDEAE6" }}>
          {queryResult.error ? (
            <span style={{ color: C.flag, fontFamily: C.mono, fontSize: 12 }}>
              {queryResult.error}
            </span>
          ) : (
            <>
              <div
                style={{
                  fontFamily: C.mono,
                  fontSize: 10,
                  color: "#8FAFA4",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                INTERPRETED AS → {queryResult.interpretation}
              </div>
              {queryResult.matches.length === 0 && (
                <div style={{ fontSize: 12, color: "#B9C9C4", fontStyle: "italic" }}>
                  No founders match every criterion. Nothing was force-fit.
                </div>
              )}
              {queryResult.matches.map((m) => {
                const f = founders.find((x) => x.id === m.id);
                if (!f) return null;
                return (
                  <div key={m.id} style={{ marginBottom: 6 }}>
                    <button
                      onClick={() => {
                        setSelected(f);
                        setView("dossier");
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#4FBFA6",
                        fontWeight: 600,
                        cursor: "pointer",
                        padding: 0,
                        fontSize: 13,
                        fontFamily: C.body,
                      }}
                    >
                      {f.name} · {f.company}
                    </button>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        color: "#B9C9C4",
                        fontFamily: C.body,
                      }}
                    >
                      {m.reason}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", minHeight: "calc(100vh - 76px)" }}>
        {/* Left rail */}
        <div
          style={{
            width: 220,
            background: C.petrol,
            padding: "16px 10px",
            flexShrink: 0,
          }}
        >
          <NavBtn id="thesis" label="Thesis Engine" />
          <NavBtn id="sourcing" label="Sourcing" />
          <NavBtn id="pipeline" label="Pipeline" />
          <NavBtn id="dossier" label="Founder dossier" />
          <NavBtn id="memo" label="Memo" />
          <NavBtn id="diligence" label="Deep diligence" />

          <div
            style={{
              marginTop: 30,
              padding: "12px 14px",
              borderTop: "1px solid #1C3444",
            }}
          >
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 9,
                color: "#8FAFA4",
                textTransform: "uppercase",
                letterSpacing: 0.6,
                marginBottom: 6,
              }}
            >
              MEMORY LAYER
            </div>
            <div
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                color: "#B9C9C4",
                lineHeight: 1.6,
              }}
            >
              {founders.length} profiles ·{" "}
              {founders.reduce((n, f) => n + f.signals.length, 0)} signals
              <br />
              deduped · timestamped
              <br />
              source-tagged · never resets
            </div>
          </div>
        </div>

        {/* Main pane */}
        <div style={{ flex: 1, padding: "28px 32px", overflow: "auto" }}>
          {loading && (
            <div style={{ fontFamily: C.mono, fontSize: 12, color: C.inkSoft }}>
              Loading founders from memory layer…
            </div>
          )}

          {!loading && view === "thesis" && (
            <ThesisView
              thesis={thesis}
              setThesis={setThesis}
              founders={founders}
              matchCount={ranked.length}
            />
          )}

          {!loading && view === "sourcing" && (
            <SourcingView
              founders={founders}
              onOpen={(f) => {
                setSelected(f);
                setView("dossier");
              }}
            />
          )}

          {!loading && view === "pipeline" && (
            <>
              <LivePipelineView />
              <div
                style={{
                  margin: "32px 0 16px",
                  paddingTop: 20,
                  borderTop: `1px dashed ${C.line}`,
                }}
              >
                <div
                  style={{
                    fontFamily: C.mono,
                    fontSize: 10,
                    color: C.inkSoft,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginBottom: 6,
                  }}
                >
                  Featured examples — fully-diligenced demo profiles
                </div>
                <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 16 }}>
                  The live Pipeline above runs on real ingested candidates scored in
                  real time. These six seeded founders keep a fully-populated
                  dossier/memo path for demoing the end-to-end diligence flow.
                </div>
              </div>
              <PipelineView
                ranked={ranked}
                onDossier={(f) => {
                  setSelected(f);
                  setView("dossier");
                }}
                onMemo={genMemo}
              />
            </>
          )}

          {!loading && view === "dossier" && selected && (
            <DossierView f={selected} onMemo={genMemo} />
          )}

          {!loading && view === "memo" && (
            <MemoView memo={memo} memoBusy={memoBusy} />
          )}

          {!loading && view === "diligence" && <DiligenceView />}
        </div>
      </div>
    </div>
  );
}

/* -------- Thesis Engine tab -------- */
function ThesisView({
  thesis,
  setThesis,
  founders,
  matchCount,
}: {
  thesis: typeof DEFAULT_THESIS;
  setThesis: React.Dispatch<React.SetStateAction<typeof DEFAULT_THESIS>>;
  founders: Founder[];
  matchCount: number;
}) {
  const distinct = (key: "sector" | "stage" | "geo") =>
    Array.from(new Set(founders.map((f) => f[key]).filter(Boolean))).sort();
  const sectorOpts = distinct("sector");
  const stageOpts = distinct("stage");
  const geoOpts = distinct("geo");

  const toggle = (
    field: "sectors" | "stages" | "geos",
    value: string,
  ) =>
    setThesis((t) => ({
      ...t,
      [field]: t[field].includes(value)
        ? t[field].filter((x) => x !== value)
        : [...t[field], value],
    }));

  const resetFilters = () =>
    setThesis({
      sectors: sectorOpts,
      stages: stageOpts,
      geos: geoOpts,
      check: "$100K",
      ownership: "3-5%",
      risk: "High — pre-track-record OK",
    });

  const labelStyle: React.CSSProperties = {
    fontFamily: C.mono,
    fontSize: 10,
    color: C.inkSoft,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
    display: "block",
  };
  const selectStyle: React.CSSProperties = {
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${C.line}`,
    background: C.card,
    fontFamily: C.body,
    color: C.ink,
    minWidth: 140,
  };

  return (
    <div>
      <h2 style={{ fontFamily: C.disp, fontSize: 30, margin: 0, fontWeight: 600 }}>
        Thesis Engine
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 6, marginBottom: 20 }}>
        Every recommendation downstream is filtered and scored through this lens. Change
        it and watch the pipeline re-rank.
      </p>

      <div
        style={{
          background: C.card,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          padding: 14,
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          alignItems: "flex-end",
        }}
      >
        <MultiSelectDropdown
          label="Sector"
          options={sectorOpts}
          selected={thesis.sectors}
          onToggle={(v) => toggle("sectors", v)}
          labelStyle={labelStyle}
          triggerStyle={selectStyle}
        />
        <MultiSelectDropdown
          label="Stage"
          options={stageOpts}
          selected={thesis.stages}
          onToggle={(v) => toggle("stages", v)}
          labelStyle={labelStyle}
          triggerStyle={selectStyle}
        />
        <MultiSelectDropdown
          label="Geography"
          options={geoOpts}
          selected={thesis.geos}
          onToggle={(v) => toggle("geos", v)}
          labelStyle={labelStyle}
          triggerStyle={selectStyle}
        />
        <div>
          <span style={labelStyle}>Check size</span>
          <select
            value={thesis.check}
            onChange={(e) => setThesis((t) => ({ ...t, check: e.target.value }))}
            style={selectStyle}
          >
            {CHECK_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span style={labelStyle}>Ownership target</span>
          <select
            value={thesis.ownership}
            onChange={(e) => setThesis((t) => ({ ...t, ownership: e.target.value }))}
            style={selectStyle}
          >
            {OWNERSHIP_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span style={labelStyle}>Risk appetite</span>
          <select
            value={thesis.risk}
            onChange={(e) => setThesis((t) => ({ ...t, risk: e.target.value }))}
            style={selectStyle}
          >
            {RISK_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: C.mono,
              fontSize: 11,
              color: C.inkSoft,
            }}
          >
            {matchCount} of {founders.length} founders match
          </span>
          <button
            onClick={resetFilters}
            style={{
              fontFamily: C.mono,
              fontSize: 11,
              padding: "6px 10px",
              borderRadius: 6,
              border: `1px solid ${C.line}`,
              background: "transparent",
              color: C.ink,
              cursor: "pointer",
            }}
          >
            Reset filters
          </button>
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          fontSize: 12,
          color: C.inkSoft,
          fontStyle: "italic",
          fontFamily: C.body,
        }}
      >
        Fit scoring is transparent — open any pipeline card to see exactly why it
        ranked where it did.
      </div>
    </div>
  );
}

function MultiSelectDropdown({
  label,
  options,
  selected,
  onToggle,
  labelStyle,
  triggerStyle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  labelStyle: React.CSSProperties;
  triggerStyle: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const count = selected.length;
  const displayLabel =
    count === 0
      ? "All"
      : count === 1
        ? selected[0]
        : `${count} selected`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <span style={labelStyle}>
        {label}
        {count > 1 ? ` (${count})` : ""}
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          ...triggerStyle,
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 160,
          }}
        >
          {displayLabel}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.inkSoft }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 8,
            padding: 6,
            minWidth: 180,
            maxHeight: 240,
            overflowY: "auto",
            boxShadow: "0 6px 20px rgba(0,0,0,0.08)",
          }}
        >
          {options.length === 0 && (
            <div
              style={{
                fontSize: 12,
                color: C.inkSoft,
                padding: 6,
                fontFamily: C.body,
              }}
            >
              No options
            </div>
          )}
          {options.map((o) => {
            const checked = selected.includes(o);
            return (
              <label
                key={o}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  padding: "4px 6px",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontFamily: C.body,
                  color: C.ink,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(o)}
                />
                {o}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------- Sourcing tab -------- */
function SourcingView({
  founders,
  onOpen,
}: {
  founders: Founder[];
  onOpen: (f: Founder) => void;
}) {
  return (
    <div>
      <h2 style={{ fontFamily: C.disp, fontSize: 28, margin: 0, fontWeight: 600 }}>
        Sourcing — one funnel, two doors
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 6, marginBottom: 20 }}>
        Inbound applications and outbound scans (GitHub, launches, hackathons, papers,
        accelerators) are scored identically and converge into the same screening step.
        Outbound activation now lives next to real ingested candidates in the{" "}
        <b>Pipeline</b> tab, not on the seeded demo founders below.
      </p>
      <LiveSignalsPanel />
      {founders.map((f) => (
        <div
          key={f.id}
          style={{
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            padding: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <Chip tone={f.track === "outbound" ? "amber" : "sea"}>{f.track.toUpperCase()}</Chip>
            <span style={{ fontFamily: C.disp, fontSize: 18, fontWeight: 600 }}>{f.name}</span>
            <span style={{ fontSize: 13, color: C.inkSoft }}>
              {f.company} — {f.oneLiner}
            </span>
            <span style={{ marginLeft: "auto", fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
              {f.geo}
            </span>
          </div>
          <div>
            {f.signals.map((s) => (
              <Evidence key={s.id} s={s} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              onClick={() => onOpen(f)}
              style={{
                fontSize: 12,
                padding: "6px 12px",
                borderRadius: 8,
                border: `1px solid ${C.line}`,
                background: "#fff",
                cursor: "pointer",
                fontFamily: C.body,
              }}
            >
              Open dossier
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------- Pipeline tab -------- */
type PeopleCandidate = {
  identity_key: string;
  person_or_handle: string;
  sources: string;
  companies: string;
  source_count: number;
  signal_count: number;
  axes: CandidateScore | null;
  founder_score: {
    value: number;
    low: number;
    high: number;
    trend: string;
    coldStart: boolean;
  } | null;
  momentum: number[];
  scored_at: string | null;
  activated_at: string | null;
  outreach_draft: string | null;
};

function LivePipelineView() {
  const scoreFn = useServerFn(scoreCandidate);
  const screenFn = useServerFn(screenCandidate);
  const aiFn = useServerFn(askAI);
  const convergeFn = useServerFn(convergeCandidate);
  const getCandidatesFn = useServerFn(getPeopleCandidates);
  const [candidates, setCandidates] = useState<PeopleCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");
  const [scores, setScores] = useState<
    Record<string, CandidateScore | { error: string }>
  >({});
  const [scoring, setScoring] = useState<Record<string, boolean>>({});
  // Pre-screen state: identity_key -> {pass, reason}. Absent = not yet screened.
  const [screened, setScreened] = useState<
    Record<string, { pass: boolean; reason: string }>
  >({});
  const [showRejected, setShowRejected] = useState(false);
  // Outreach draft state, keyed by identity_key.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState<Record<string, boolean>>({});
  const [converging, setConverging] = useState<Record<string, boolean>>({});
  const [activated, setActivated] = useState<Record<string, string>>({});
  const [activateErr, setActivateErr] = useState<Record<string, string>>({});

  const sourceTone: Record<string, "sea" | "amber" | "cool" | "flag"> = {
    github: "cool",
    hacker_news: "amber",
    arxiv: "sea",
    yc: "flag",
  };
  const isBuilderSource = (s: string) => /github|hacker_news|arxiv/i.test(s);

  const runScore = useCallback(
    async (key: string) => {
      setScoring((m) => ({ ...m, [key]: true }));
      try {
        const r = await scoreFn({ data: { identityKey: key } });
        setScores((m) => ({ ...m, [key]: r }));
      } catch (e) {
        setScores((m) => ({
          ...m,
          [key]: { error: e instanceof Error ? e.message : String(e) },
        }));
      } finally {
        setScoring((m) => ({ ...m, [key]: false }));
      }
    },
    [scoreFn],
  );

  const draftOutreach = useCallback(
    async (c: PeopleCandidate) => {
      const key = c.identity_key;
      setDrafting((m) => ({ ...m, [key]: true }));
      setActivateErr((m) => ({ ...m, [key]: "" }));
      try {
        const text = await aiFn({
          data: {
            prompt: `Handle: @${c.person_or_handle}. Public sources: ${c.sources}. Companies/repos inferred: ${c.companies || "(none)"}. Signal count: ${c.signal_count}. Draft a 90-word cold outreach email from an investor. Reference the SPECIFIC public work (repo, paper, post) that triggered this. Goal: get them to submit an application (deck + company name). Tone: peer-to-peer, zero flattery-spam. Plain text.`,
            system:
              "You write outreach that converts builders into applicants. Cold outreach, not cold investment.",
          },
        });
        setDrafts((m) => ({ ...m, [key]: text }));
      } catch (e) {
        setActivateErr((m) => ({
          ...m,
          [key]: "Draft engine unreachable — " + (e instanceof Error ? e.message : String(e)),
        }));
      } finally {
        setDrafting((m) => ({ ...m, [key]: false }));
      }
    },
    [aiFn],
  );

  const confirmActivate = useCallback(
    async (c: PeopleCandidate) => {
      const key = c.identity_key;
      const draft = drafts[key];
      if (!draft) return;
      setConverging((m) => ({ ...m, [key]: true }));
      setActivateErr((m) => ({ ...m, [key]: "" }));
      try {
        const r = await convergeFn({
          data: { identityKey: key, outreachDraft: draft },
        });
        setActivated((m) => ({ ...m, [key]: r.activatedAt }));
        setCandidates((rows) =>
          rows.map((row) =>
            row.identity_key === key
              ? { ...row, activated_at: r.activatedAt, outreach_draft: draft }
              : row,
          ),
        );
      } catch (e) {
        setActivateErr((m) => ({
          ...m,
          [key]: "Converge failed — " + (e instanceof Error ? e.message : String(e)),
        }));
      } finally {
        setConverging((m) => ({ ...m, [key]: false }));
      }
    },
    [convergeFn, drafts],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let data: unknown[] = [];
      try {
        data = await getCandidatesFn({ data: { limit: 200 } });
      } catch (error) {
        if (cancelled) return;
        setErr(error instanceof Error ? error.message : String(error));
        setLoading(false);
        return;
      }
      if (cancelled) return;
      const rows = ((data ?? []) as unknown as PeopleCandidate[])
        .sort((a, b) => {
          const ba = isBuilderSource(a.sources) ? 1 : 0;
          const bb = isBuilderSource(b.sources) ? 1 : 0;
          if (ba !== bb) return bb - ba;
          return b.signal_count - a.signal_count;
        })
        .slice(0, 50);
      setCandidates(rows);
      setLoading(false);
      // Seed from persisted axes so we don't re-score every session.
      const seeded: Record<string, CandidateScore> = {};
      for (const r of rows) {
        if (r.axes) seeded[r.identity_key] = r.axes;
      }
      if (Object.keys(seeded).length > 0) {
        setScores((m) => ({ ...seeded, ...m }));
      }
      // Seed activation state + outreach drafts from persisted columns.
      const seedActivated: Record<string, string> = {};
      const seedDrafts: Record<string, string> = {};
      for (const r of rows) {
        if (r.activated_at) seedActivated[r.identity_key] = r.activated_at;
        if (r.outreach_draft) seedDrafts[r.identity_key] = r.outreach_draft;
      }
      if (Object.keys(seedActivated).length > 0)
        setActivated((m) => ({ ...seedActivated, ...m }));
      if (Object.keys(seedDrafts).length > 0)
        setDrafts((m) => ({ ...seedDrafts, ...m }));
      // Only score rows whose scored_at is null or older than 7 days.
      const staleMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const stale = rows.filter((r) => {
        if (!r.scored_at) return true;
        const t = Date.parse(r.scored_at);
        return Number.isNaN(t) || now - t > staleMs;
      });
      // Bounded auto-scoring: top 5 only, in small batches of 2 with a
      // short delay between batches, each call fully isolated. Manual
      // "Enrich & score" button covers the rest.
      (async () => {
        const toScore = stale.slice(0, 5);
        for (let i = 0; i < toScore.length; i += 2) {
          if (cancelled) return;
          const batch = toScore.slice(i, i + 2);
          await Promise.all(
            batch.map((c) =>
              (async () => {
                // Cheap pre-screen gate first.
                const text = [
                  `handle: @${c.person_or_handle}`,
                  `sources: ${c.sources}`,
                  c.companies ? `companies/repos: ${c.companies}` : "",
                  `signal_count: ${c.signal_count}`,
                ]
                  .filter(Boolean)
                  .join("\n");
                try {
                  const s = await screenFn({ data: { text, thesis: "" } });
                  setScreened((m) => ({ ...m, [c.identity_key]: s }));
                  if (!s.pass) return; // skip expensive scoring
                } catch {
                  // Fail open — screener error should not block scoring.
                }
                await runScore(c.identity_key).catch(() => {
                  /* runScore already stores { error } — never rethrow */
                });
              })(),
            ),
          );
          if (i + 2 < toScore.length) await new Promise((r) => setTimeout(r, 800));
        }
      })().catch(() => {
        /* defensive: no unhandled rejection escapes */
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [runScore, screenFn, getCandidatesFn]);

  return (
    <div>
      <h2 style={{ fontFamily: C.disp, fontSize: 28, margin: 0, fontWeight: 600 }}>
        Pipeline — live ingested candidates
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 6, marginBottom: 20 }}>
        Real people_candidates from GitHub, Hacker News, arXiv, and YC. Builders
        (GH/HN/arXiv) rank above YC. Three axes scored live by GPT-4o against the
        candidate's real signals — any axis without enough evidence renders as
        <b> unscorable — flagged</b>, never a made-up number.
      </p>
      {loading && (
        <div style={{ fontSize: 13, color: C.inkSoft }}>Loading live candidates…</div>
      )}
      {err && (
        <div style={{ fontSize: 13, color: C.flag }}>Load failed: {err}</div>
      )}
      {!loading && candidates.length === 0 && (
        <div style={{ fontSize: 13, color: C.inkSoft }}>
          No candidates yet. Open the Sourcing tab and click{" "}
          <b>Refresh live signals</b> to ingest from public APIs.
        </div>
      )}
      {candidates
        .filter((c) => screened[c.identity_key]?.pass !== false)
        .map((c) => {
        const key = c.identity_key;
        const result = scores[key];
        const busy = scoring[key];
        const srcList = c.sources
          .split(";")
          .map((x) => x.trim())
          .filter(Boolean);
        const scored = result && !("error" in result);
        const axes = scored
          ? ([
              ["Founder", result.founder],
              ["Market", result.market],
              ["Idea vs Market", result.idea_vs_market],
            ] as const)
          : null;
        return (
          <div
            key={key}
            style={{
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 12,
              padding: 16,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <Chip tone="cool">people candidate</Chip>
              <span style={{ fontFamily: C.disp, fontSize: 18, fontWeight: 600 }}>
                @{c.person_or_handle}
              </span>
              {srcList.map((s) => (
                <Chip key={s} tone={sourceTone[s] ?? "sea"}>
                  {s}
                </Chip>
              ))}
              <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
                {c.signal_count} signals · {c.source_count} sources
              </span>
              <button
                onClick={() => runScore(key)}
                disabled={busy}
                style={{
                  marginLeft: "auto",
                  fontSize: 12,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: `1px solid ${C.sea}`,
                  background: busy ? C.seaSoft : "#fff",
                  color: C.sea,
                  cursor: busy ? "wait" : "pointer",
                  fontFamily: C.body,
                  fontWeight: 600,
                }}
              >
                {busy
                  ? "Enriching & scoring…"
                  : result
                    ? "Re-enrich & score"
                    : "Enrich & score"}
              </button>
            </div>
            {c.companies && (
              <div
                style={{
                  fontFamily: C.mono,
                  fontSize: 10,
                  color: C.inkSoft,
                  marginBottom: 10,
                }}
              >
                {c.companies}
              </div>
            )}
            {(c.founder_score || c.momentum.length > 0) && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  marginBottom: 10,
                  padding: "8px 10px",
                  background: C.paper,
                  border: `1px solid ${C.line}`,
                  borderRadius: 8,
                }}
              >
                {c.founder_score && (
                  <>
                    <span
                      style={{
                        fontFamily: C.disp,
                        fontSize: 22,
                        fontWeight: 600,
                        color: C.ink,
                      }}
                    >
                      {c.founder_score.value}
                    </span>
                    <span
                      style={{ fontFamily: C.mono, fontSize: 10, color: C.inkSoft }}
                    >
                      composite · range {c.founder_score.low}–{c.founder_score.high} ·{" "}
                      trend {c.founder_score.trend}
                    </span>
                  </>
                )}
                {c.momentum.length > 1 && <Spark data={c.momentum} />}
                {c.scored_at && (
                  <span
                    style={{
                      fontFamily: C.mono,
                      fontSize: 10,
                      color: C.inkSoft,
                      marginLeft: "auto",
                    }}
                  >
                    scored {new Date(c.scored_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              {(["Founder", "Market", "Idea vs Market"] as const).map((label, i) => {
                const ax = axes ? axes[i][1] : null;
                return (
                  <div
                    key={label}
                    style={{
                      background: C.paper,
                      padding: 10,
                      borderRadius: 8,
                      border: `1px solid ${C.line}`,
                      minHeight: 88,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: C.mono,
                        fontSize: 9,
                        color: C.inkSoft,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        marginBottom: 6,
                      }}
                    >
                      {label}
                    </div>
                    {!ax && !busy && (
                      <div style={{ fontSize: 11, color: C.inkSoft }}>
                        Not scored yet — click <b>Score</b>.
                      </div>
                    )}
                    {!ax && busy && (
                      <div style={{ fontSize: 11, color: C.inkSoft }}>Scoring…</div>
                    )}
                    {ax && ax.unscorable && (
                      <>
                        <Chip tone="amber">unscorable — flagged</Chip>
                        <div
                          style={{
                            fontSize: 11,
                            color: C.inkSoft,
                            marginTop: 6,
                            lineHeight: 1.45,
                          }}
                        >
                          {ax.reason}
                        </div>
                      </>
                    )}
                    {ax && !ax.unscorable && ax.score !== null && (
                      <>
                        <div style={{ fontFamily: C.disp, fontSize: 22, fontWeight: 600 }}>
                          {ax.score}/10
                        </div>
                        {ax.low !== null && ax.high !== null && (
                          <div
                            style={{
                              fontFamily: C.mono,
                              fontSize: 10,
                              color: C.inkSoft,
                              marginTop: 2,
                            }}
                          >
                            range {ax.low}–{ax.high}
                          </div>
                        )}
                        <div
                          style={{
                            fontSize: 11,
                            color: C.inkSoft,
                            marginTop: 6,
                            lineHeight: 1.45,
                          }}
                        >
                          {ax.reason}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {result && "error" in result && (
              <div style={{ marginTop: 8, fontSize: 12, color: C.flag }}>
                {result.error}
              </div>
            )}
            {scored && result.sources_used.length > 0 && (
              <div
                style={{
                  fontFamily: C.mono,
                  fontSize: 10,
                  color: C.inkSoft,
                  marginTop: 8,
                }}
              >
                sources: {result.sources_used.join(", ")}
              </div>
            )}
            {/* -------- Activate → Converge (outbound only) -------- */}
            {(() => {
              const isActivated = Boolean(activated[key] ?? c.activated_at);
              const draft = drafts[key];
              const isDrafting = drafting[key];
              const isConverging = converging[key];
              const errMsg = activateErr[key];
              return (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: `1px dashed ${C.line}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: C.mono,
                        fontSize: 10,
                        color: C.inkSoft,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      Outbound activate
                    </span>
                    {isActivated ? (
                      <>
                        <Chip tone="sea">activated</Chip>
                        <span
                          style={{
                            fontFamily: C.mono,
                            fontSize: 10,
                            color: C.inkSoft,
                          }}
                        >
                          {new Date(
                            activated[key] ?? c.activated_at ?? "",
                          ).toLocaleString()}{" "}
                          · now a founders row (track=outbound), flows through
                          Screening / Dossier / Memo like an inbound application.
                        </span>
                      </>
                    ) : !draft ? (
                      <button
                        onClick={() => draftOutreach(c)}
                        disabled={isDrafting}
                        style={{
                          fontSize: 12,
                          padding: "6px 12px",
                          borderRadius: 8,
                          border: "none",
                          background: C.sea,
                          color: "#fff",
                          cursor: isDrafting ? "wait" : "pointer",
                          fontFamily: C.body,
                          fontWeight: 600,
                        }}
                      >
                        {isDrafting ? "Drafting outreach…" : "Activate → draft outreach"}
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => confirmActivate(c)}
                          disabled={isConverging}
                          style={{
                            fontSize: 12,
                            padding: "6px 12px",
                            borderRadius: 8,
                            border: "none",
                            background: C.sea,
                            color: "#fff",
                            cursor: isConverging ? "wait" : "pointer",
                            fontFamily: C.body,
                            fontWeight: 600,
                          }}
                        >
                          {isConverging
                            ? "Converging into founders…"
                            : "Mark as activated → converge to founders"}
                        </button>
                        <button
                          onClick={() => draftOutreach(c)}
                          disabled={isDrafting}
                          style={{
                            fontSize: 12,
                            padding: "6px 12px",
                            borderRadius: 8,
                            border: `1px solid ${C.line}`,
                            background: "#fff",
                            cursor: isDrafting ? "wait" : "pointer",
                            fontFamily: C.body,
                          }}
                        >
                          {isDrafting ? "Re-drafting…" : "Re-draft"}
                        </button>
                      </>
                    )}
                  </div>
                  {(draft || c.outreach_draft) && (
                    <pre
                      style={{
                        marginTop: 10,
                        padding: 12,
                        background: C.seaSoft,
                        borderRadius: 8,
                        fontFamily: C.mono,
                        fontSize: 12,
                        color: C.ink,
                        whiteSpace: "pre-wrap",
                        margin: "10px 0 0 0",
                      }}
                    >
                      {draft ?? c.outreach_draft}
                    </pre>
                  )}
                  {errMsg && (
                    <div style={{ marginTop: 8, fontSize: 12, color: C.flag }}>
                      {errMsg}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        );
      })}
      {(() => {
        const rejected = candidates.filter(
          (c) => screened[c.identity_key]?.pass === false,
        );
        if (rejected.length === 0) return null;
        return (
          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => setShowRejected((v) => !v)}
              style={{
                fontFamily: C.mono,
                fontSize: 11,
                color: C.inkSoft,
                background: "transparent",
                border: `1px dashed ${C.line}`,
                borderRadius: 8,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              {showRejected ? "▾" : "▸"} Not advanced — {rejected.length}{" "}
              screened out by pre-screen gate
            </button>
            {showRejected && (
              <div style={{ marginTop: 10 }}>
                {rejected.map((c) => {
                  const s = screened[c.identity_key];
                  return (
                    <div
                      key={c.identity_key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        background: C.paper,
                        border: `1px solid ${C.line}`,
                        borderRadius: 8,
                        marginBottom: 6,
                        fontSize: 12,
                      }}
                    >
                      <Chip tone="amber">screened out</Chip>
                      <span
                        style={{ fontFamily: C.disp, fontWeight: 600 }}
                      >
                        @{c.person_or_handle}
                      </span>
                      <span
                        style={{
                          fontFamily: C.mono,
                          fontSize: 10,
                          color: C.inkSoft,
                        }}
                      >
                        {c.sources}
                      </span>
                      <span style={{ color: C.inkSoft, marginLeft: "auto" }}>
                        {s?.reason || "disqualified"}
                      </span>
                      <button
                        onClick={() => {
                          setScreened((m) => {
                            const n = { ...m };
                            delete n[c.identity_key];
                            return n;
                          });
                          runScore(c.identity_key);
                        }}
                        style={{
                          fontSize: 11,
                          padding: "4px 8px",
                          borderRadius: 6,
                          border: `1px solid ${C.sea}`,
                          background: "#fff",
                          color: C.sea,
                          cursor: "pointer",
                          fontFamily: C.body,
                        }}
                      >
                        Override & score
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function PipelineView({
  ranked,
  onDossier,
  onMemo,
}: {
  ranked: { f: Founder; fit: number; why: string[] }[];
  onDossier: (f: Founder) => void;
  onMemo: (f: Founder) => void;
}) {
  return (
    <div>
      <h2 style={{ fontFamily: C.disp, fontSize: 28, margin: 0, fontWeight: 600 }}>
        Pipeline — three axes, never averaged
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 6, marginBottom: 20 }}>
        Founder · Market · Idea-vs-Market are independent. Disagreement between them is
        the signal — collapsing to one number would hide the decision.
      </p>
      {ranked.length === 0 && (
        <div
          style={{
            background: C.card,
            border: `1px dashed ${C.line}`,
            borderRadius: 12,
            padding: 24,
            textAlign: "center",
            fontFamily: C.body,
            fontSize: 13,
            color: C.inkSoft,
          }}
        >
          No founders match this thesis — try widening your filters.
        </div>
      )}
      {ranked.map(({ f, fit, why }) => {
        const hasContradiction = f.claims.some((c) => c.flag);
        return (
          <div
            key={f.id}
            style={{
              background: C.card,
              border: `1px solid ${hasContradiction ? C.flag : C.line}`,
              borderRadius: 12,
              padding: 16,
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontFamily: C.disp, fontSize: 20, fontWeight: 600 }}>{f.name}</span>
              <span style={{ fontSize: 13, color: C.inkSoft }}>{f.company}</span>
              <span style={{ marginLeft: 6 }}>
                {f.tags.map((t) => (
                  <Chip
                    key={t}
                    tone={t.includes("contradiction") ? "flag" : t.includes("disagree") ? "amber" : "cool"}
                  >
                    {t}
                  </Chip>
                ))}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: C.mono,
                  fontSize: 11,
                  color: C.ink,
                }}
              >
                thesis fit {fit}/100
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
                marginBottom: 12,
              }}
            >
              {(
                [
                  ["Founder", f.axes?.founder],
                  ["Market", f.axes?.market],
                  ["Idea vs Market", f.axes?.ideaVsMarket],
                ] as const
              ).map(([label, axRaw]) => {
                const ax = (axRaw ?? { score: null, trend: null, note: "unscorable — flagged: no data", rating: null }) as {
                  score: number | null;
                  trend: string | null;
                  note: string;
                  rating?: string | null;
                };
                return (
                <div
                  key={label}
                  style={{
                    background: C.paper,
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${C.line}`,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      style={{
                        fontFamily: C.mono,
                        fontSize: 9,
                        color: C.inkSoft,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      {label.toUpperCase()}
                    </span>
                    <Trend t={ax.trend} />
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
                    {ax.score === null ? (
                      <span style={{ fontFamily: C.mono, fontSize: 12, color: C.amber }}>
                        unscorable — flagged
                      </span>
                    ) : (
                      <span style={{ fontFamily: C.disp, fontSize: 22, fontWeight: 600 }}>
                        {ax.score.toFixed(1)}
                      </span>
                    )}
                    {ax.rating && <Chip tone={ax.rating === "bullish" ? "sea" : "cool"}>{ax.rating}</Chip>}
                  </div>
                  <div style={{ fontSize: 11, color: C.inkSoft, marginTop: 6, lineHeight: 1.45 }}>
                    {ax.note}
                  </div>
                </div>
                );
              })}
            </div>
            <details style={{ marginBottom: 8 }}>
              <summary
                style={{
                  cursor: "pointer",
                  fontFamily: C.mono,
                  fontSize: 10,
                  color: C.inkSoft,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                why this rank (thesis trace)
              </summary>
              <div
                style={{
                  fontFamily: C.mono,
                  fontSize: 11,
                  color: C.inkSoft,
                  marginTop: 6,
                  lineHeight: 1.6,
                }}
              >
                {why.map((w, i) => (
                  <div key={i}>· {w}</div>
                ))}
              </div>
            </details>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => onDossier(f)}
                style={{
                  fontSize: 12,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: `1px solid ${C.line}`,
                  background: "#fff",
                  cursor: "pointer",
                  fontFamily: C.body,
                }}
              >
                Dossier
              </button>
              <button
                onClick={() => onMemo(f)}
                style={{
                  fontSize: 12,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: C.sea,
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontFamily: C.body,
                }}
              >
                Generate memo →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------- Dossier tab -------- */
function DossierView({ f, onMemo }: { f: Founder; onMemo: (f: Founder) => void }) {
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontFamily: C.disp, fontSize: 34, margin: 0, fontWeight: 600 }}>{f.name}</h2>
        <div style={{ fontSize: 13, color: C.inkSoft, marginTop: 4 }}>
          {f.company} · {f.geo} · {f.sector}
        </div>
      </div>

      <div
        style={{
          background: C.card,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          padding: 18,
          marginBottom: 18,
        }}
      >
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            color: C.inkSoft,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 10,
          }}
        >
          FOUNDER SCORE — lives in Memory, persists across ventures, never resets
        </div>
        <ScoreBand fs={f.founderScore} />
        {f.founderScore.history && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              background: C.coolSoft,
              borderRadius: 8,
              fontSize: 12,
              color: C.cool,
              fontFamily: C.body,
            }}
          >
            Cross-venture memory: {f.founderScore.history}
          </div>
        )}
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              fontFamily: C.mono,
              fontSize: 10,
              color: C.inkSoft,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            90-DAY TREND
          </span>
          <Spark data={f.momentum} />
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 }}>
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            color: C.inkSoft,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 10,
          }}
        >
          CLAIMS — each traced to evidence with a Trust Score (per claim, not per company)
        </div>
        {f.claims.length === 0 && (
          <div style={{ fontSize: 12, color: C.inkSoft, fontStyle: "italic", marginBottom: 12 }}>
            No claims yet — profile is signal-only until an application arrives.
          </div>
        )}
        {f.claims.map((c, i) => (
          <div
            key={i}
            style={{
              borderLeft: `3px solid ${c.trust >= 0.75 ? C.sea : C.amber}`,
              padding: "8px 12px",
              marginBottom: 8,
              background: c.flag ? C.flagSoft : "transparent",
              borderRadius: c.flag ? 8 : 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{c.claim}</span>
              <TrustDot v={c.trust} />
              {c.flag && <Chip tone="flag">⚠ {c.flag}</Chip>}
            </div>
            <div style={{ fontSize: 11, color: C.inkSoft, marginTop: 4, lineHeight: 1.5 }}>
              {c.evidence}
            </div>
          </div>
        ))}

        <div
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            color: C.inkSoft,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginTop: 16,
            marginBottom: 8,
          }}
        >
          RAW SIGNALS
        </div>
        {f.signals.map((s) => (
          <Evidence key={s.id} s={s} />
        ))}

        <div
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            color: C.inkSoft,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginTop: 16,
            marginBottom: 8,
          }}
        >
          DECLARED GAPS — flagged, never invented
        </div>
        {f.gaps.map((g, i) => (
          <div key={i} style={{ fontSize: 12, color: C.amber, marginBottom: 4 }}>
            <Chip tone="amber">gap</Chip> {g}
          </div>
        ))}
      </div>

      <button
        onClick={() => onMemo(f)}
        style={{
          marginTop: 14,
          fontSize: 13,
          padding: "10px 18px",
          borderRadius: 8,
          border: "none",
          background: C.sea,
          color: "#fff",
          cursor: "pointer",
          fontWeight: 600,
          fontFamily: C.body,
        }}
      >
        Generate evidence-backed memo →
      </button>
    </div>
  );
}

/* -------- Memo tab -------- */
function MemoView({
  memo,
  memoBusy,
}: {
  memo: { founder: Founder; text: string } | null;
  memoBusy: boolean;
}) {
  return (
    <div style={{ maxWidth: 780 }}>
      <h2 style={{ fontFamily: C.disp, fontSize: 28, margin: 0, fontWeight: 600 }}>
        Investment memo{memo ? ` — ${memo.founder.name}` : ""}
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 6, marginBottom: 20 }}>
        Every claim cites its evidence ID and trust level. Gaps are flagged, not filled.
        Contradictions surface before the investor decides.
      </p>
      {memoBusy && (
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 12,
            color: C.inkSoft,
            fontStyle: "italic",
          }}
        >
          Reasoning over the evidence record… (the memo is drafted live from the
          structured dossier — nothing is templated)
        </div>
      )}
      {!memoBusy && !memo && (
        <div style={{ fontSize: 13, color: C.inkSoft, fontStyle: "italic" }}>
          Pick a founder in the Pipeline or Dossier tab and generate a memo.
        </div>
      )}
      {memo && !memoBusy && (
        <pre
          style={{
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            padding: 20,
            fontFamily: C.body,
            fontSize: 13,
            lineHeight: 1.65,
            color: C.ink,
            whiteSpace: "pre-wrap",
          }}
        >
          {memo.text}
        </pre>
      )}
    </div>
  );
}
/* -------- Live signals panel (public API ingestion) -------- */
type SignalRow = {
  signal_id: string;
  source: string;
  person_or_handle: string;
  company: string;
  text: string;
  url: string;
  date: string;
  reliability: number;
};

function LiveSignalsPanel() {
  const ingest = useServerFn(runIngest);
  const scoreFn = useServerFn(scoreCandidate);
  const getSignalsFn = useServerFn(getSignals);
  const getCandidatesFn = useServerFn(getPeopleCandidates);
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [candidates, setCandidates] = useState<
    Array<{
      identity_key: string;
      person_or_handle: string;
      sources: string;
      companies: string;
      source_count: number;
      signal_count: number;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [source, setSource] = useState<string>("all");
  const [scores, setScores] = useState<Record<string, CandidateScore | { error: string }>>({});
  const [scoring, setScoring] = useState<Record<string, boolean>>({});

  const normId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const runScore = useCallback(
    async (handle: string) => {
      const key = normId(handle);
      if (!key) return;
      setScoring((m) => ({ ...m, [key]: true }));
      try {
        const result = await scoreFn({ data: { identityKey: key } });
        setScores((m) => ({ ...m, [key]: result }));
      } catch (e) {
        setScores((m) => ({
          ...m,
          [key]: { error: e instanceof Error ? e.message : String(e) },
        }));
      } finally {
        setScoring((m) => ({ ...m, [key]: false }));
      }
    },
    [scoreFn],
  );

  const load = useCallback(async () => {
    try {
      const data = await getSignalsFn({ data: { source, limit: 60 } });
      setRows(data as unknown as SignalRow[]);
    } catch (error) {
      setStatus(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      const cData = await getCandidatesFn({ data: { limit: 200 } });
      setCandidates(cData as unknown as typeof candidates);
    } catch {
      /* non-fatal */
    }
  }, [source, getSignalsFn, getCandidatesFn]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setLoading(true);
    setStatus("Fetching GitHub, Hacker News, arXiv, and YC…");
    try {
      const r = await ingest({ data: { days: 90, limit: 30 } });
      setStatus(
        `Ingested ${r.signalCount} signals · ${r.peopleCount} people · sources: ${Object.entries(
          r.sourceCounts,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      );
      await load();
    } catch (e) {
      setStatus(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const sourceTone: Record<string, "sea" | "amber" | "cool" | "flag"> = {
    github: "cool",
    hacker_news: "amber",
    arxiv: "sea",
    yc: "flag",
  };

  // Prioritize pre-fundraise builders (GH/HN/arXiv) above YC candidates.
  const isBuilderSource = (sources: string) =>
    /github|hacker_news|arxiv/i.test(sources);
  const rankedCandidates = [...candidates]
    .sort((a, b) => {
      const ba = isBuilderSource(a.sources) ? 1 : 0;
      const bb = isBuilderSource(b.sources) ? 1 : 0;
      if (ba !== bb) return bb - ba;
      return b.signal_count - a.signal_count;
    })
    .slice(0, 20);

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        padding: 16,
        marginBottom: 20,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontFamily: C.disp, fontSize: 18, fontWeight: 600 }}>
          Live signals — public APIs
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
          GitHub · Hacker News · arXiv · YC
        </span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          style={{
            marginLeft: "auto",
            fontFamily: C.mono,
            fontSize: 11,
            padding: "4px 8px",
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            background: "#fff",
          }}
        >
          <option value="all">all sources</option>
          <option value="github">github</option>
          <option value="hacker_news">hacker_news</option>
          <option value="arxiv">arxiv</option>
          <option value="yc">yc</option>
        </select>
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            fontSize: 12,
            padding: "6px 12px",
            borderRadius: 8,
            border: "none",
            background: C.sea,
            color: "#fff",
            cursor: loading ? "wait" : "pointer",
            fontWeight: 600,
            fontFamily: C.body,
          }}
        >
          {loading ? "Ingesting…" : "Refresh live signals"}
        </button>
      </div>
      {status && (
        <div style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft, marginBottom: 10 }}>
          {status}
        </div>
      )}
      {rows.length === 0 && !loading && (
        <div style={{ fontSize: 13, color: C.inkSoft }}>
          No signals yet. Click <b>Refresh live signals</b> to pull the last 90 days from
          public APIs.
        </div>
      )}
      {rankedCandidates.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span style={{ fontFamily: C.disp, fontSize: 14, fontWeight: 600 }}>
              Live ingested — real public data
            </span>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
              people_candidates · builders (GH/HN/arXiv) prioritized above YC · sorted by
              signal_count · GPT-4o scoring
            </span>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {rankedCandidates.map((c) => {
              const key = c.identity_key;
              const handle = c.person_or_handle;
              const result = scores[key];
              const busy = scoring[key];
              const srcList = c.sources
                .split(";")
                .map((x) => x.trim())
                .filter(Boolean);
              return (
                <div
                  key={key}
                    style={{
                      border: `1px solid ${C.line}`,
                      borderRadius: 8,
                      padding: 8,
                      background: "#fff",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Chip tone="cool">people candidate</Chip>
                      <span style={{ fontFamily: C.mono, fontSize: 12 }}>@{handle}</span>
                      {srcList.map((s) => (
                        <Chip key={s} tone={sourceTone[s] ?? "sea"}>
                          {s}
                        </Chip>
                      ))}
                      <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
                        {c.signal_count} signals · {c.source_count} sources
                      </span>
                      <button
                        onClick={() => runScore(handle)}
                        disabled={busy}
                        style={{
                          marginLeft: "auto",
                          fontSize: 11,
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: `1px solid ${C.sea}`,
                          background: busy ? C.seaSoft : "#fff",
                          color: C.sea,
                          cursor: busy ? "wait" : "pointer",
                          fontFamily: C.body,
                          fontWeight: 600,
                        }}
                      >
                        {busy ? "Scoring…" : result ? "Rescore" : "Score candidate"}
                      </button>
                    </div>
                    {c.companies && (
                      <div
                        style={{
                          fontFamily: C.mono,
                          fontSize: 10,
                          color: C.inkSoft,
                          marginTop: 4,
                        }}
                      >
                        {c.companies}
                      </div>
                    )}
                    {result && "error" in result && (
                      <div style={{ marginTop: 6, fontSize: 12, color: C.flag }}>
                        {result.error}
                      </div>
                    )}
                    {result && !("error" in result) && (
                      <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                        {(
                          [
                            ["Founder", result.founder],
                            ["Market", result.market],
                            ["Idea vs Market", result.idea_vs_market],
                          ] as const
                        ).map(([label, ax]) => (
                          <div
                            key={label}
                            style={{
                              display: "flex",
                              gap: 8,
                              alignItems: "flex-start",
                              fontSize: 12,
                            }}
                          >
                            <span
                              style={{
                                fontFamily: C.mono,
                                width: 110,
                                color: C.inkSoft,
                                flexShrink: 0,
                              }}
                            >
                              {label}
                            </span>
                            {ax.unscorable ? (
                              <Chip tone="amber">unscorable — flagged</Chip>
                            ) : (
                              <span
                                style={{
                                  fontFamily: C.disp,
                                  fontSize: 15,
                                  fontWeight: 600,
                                  color: C.sea,
                                  width: 32,
                                  flexShrink: 0,
                                }}
                              >
                                {ax.score}/10
                              </span>
                            )}
                            <span style={{ color: C.ink, lineHeight: 1.4 }}>
                              {ax.reason}
                            </span>
                          </div>
                        ))}
                        {result.sources_used.length > 0 && (
                          <div
                            style={{
                              fontFamily: C.mono,
                              fontSize: 10,
                              color: C.inkSoft,
                              marginTop: 4,
                            }}
                          >
                            sources: {result.sources_used.join(", ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
            })}
          </div>
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((s) => (
          <a
            key={s.signal_id}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "block",
              padding: 10,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              textDecoration: "none",
              color: C.ink,
              background: "#fff",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <Chip tone={sourceTone[s.source] ?? "sea"}>{s.source}</Chip>
              {s.person_or_handle && (
                <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
                  @{s.person_or_handle}
                </span>
              )}
              {s.company && (
                <span style={{ fontFamily: C.mono, fontSize: 11, color: C.inkSoft }}>
                  {s.company}
                </span>
              )}
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: C.mono,
                  fontSize: 11,
                  color: C.inkSoft,
                }}
              >
                {s.date || "—"}
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{s.text}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

/* -------- Apply modal (inbound intake) -------- */
type ApplyPayload = {
  company: string;
  oneLiner: string;
  founderName: string;
  stage: string;
  sector: string;
  geo: string;
  links: { github?: string; linkedin?: string; site?: string };
  deckBase64?: string;
  deckFilename?: string;
};

function ApplyModal({
  onClose,
  submit,
}: {
  onClose: () => void;
  submit: (p: ApplyPayload) => Promise<{ id: string; deckUrl: string | null }>;
}) {
  const [company, setCompany] = useState("");
  const [oneLiner, setOneLiner] = useState("");
  const [founderName, setFounderName] = useState("");
  const [stage, setStage] = useState("Pre-seed");
  const [sector, setSector] = useState("Applied AI");
  const [geo, setGeo] = useState("Global");
  const [github, setGithub] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [site, setSite] = useState("");
  const [deckFile, setDeckFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string } | null>(null);

  const fileToBase64 = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result ?? "");
        resolve(s.slice(s.indexOf(",") + 1));
      };
      r.onerror = reject;
      r.readAsDataURL(f);
    });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!company.trim() || !founderName.trim()) {
      setErr("Company and founder name are required.");
      return;
    }
    setBusy(true);
    try {
      let deckBase64: string | undefined;
      let deckFilename: string | undefined;
      if (deckFile) {
        if (deckFile.type !== "application/pdf") {
          throw new Error("Deck must be a PDF.");
        }
        if (deckFile.size > 20 * 1024 * 1024) {
          throw new Error("Deck exceeds 20 MB.");
        }
        deckBase64 = await fileToBase64(deckFile);
        deckFilename = deckFile.name;
      }
      const res = await submit({
        company,
        oneLiner,
        founderName,
        stage,
        sector,
        geo,
        links: {
          github: github.trim() || undefined,
          linkedin: linkedin.trim() || undefined,
          site: site.trim() || undefined,
        },
        deckBase64,
        deckFilename,
      });
      setDone({ id: res.id });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
    setBusy(false);
  };

  const label: React.CSSProperties = {
    fontFamily: C.mono,
    fontSize: 10,
    color: C.inkSoft,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
    display: "block",
  };
  const input: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 6,
    border: `1px solid ${C.line}`,
    fontFamily: C.body,
    fontSize: 13,
    background: "#fff",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,34,48,0.55)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "60px 20px 20px",
        overflowY: "auto",
      }}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          borderRadius: 12,
          maxWidth: 640,
          width: "100%",
          padding: 28,
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ fontFamily: C.disp, fontSize: 26, margin: 0, fontWeight: 600 }}>
            Apply — inbound intake
          </h2>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: C.inkSoft }}>×</button>
        </div>
        <p style={{ color: C.inkSoft, fontSize: 12, marginTop: 4, marginBottom: 20, fontFamily: C.mono }}>
          Deck + company name is the minimum bar. Everything else improves your scoring evidence.
        </p>

        {done ? (
          <div style={{ background: C.seaSoft, color: C.sea, padding: 14, borderRadius: 8, fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Application received.</div>
            <div style={{ fontFamily: C.mono, fontSize: 11 }}>id: {done.id}</div>
            <div style={{ marginTop: 8 }}>Screening enrichment + AI scoring are running now. Your card will appear in the Pipeline momentarily.</div>
            <button
              type="button"
              onClick={onClose}
              style={{ marginTop: 12, padding: "8px 14px", borderRadius: 6, border: "none", background: C.sea, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              Close
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <label style={label}>Company *</label>
              <input style={input} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} required />
            </div>
            <div>
              <label style={label}>Founder name(s) *</label>
              <input style={input} value={founderName} onChange={(e) => setFounderName(e.target.value)} maxLength={200} required />
            </div>
            <div>
              <label style={label}>One-liner</label>
              <input style={input} value={oneLiner} onChange={(e) => setOneLiner(e.target.value)} maxLength={240} placeholder="What are you building, in one sentence?" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div>
                <label style={label}>Stage</label>
                <select style={input} value={stage} onChange={(e) => setStage(e.target.value)}>
                  {["Pre-seed", "Seed"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={label}>Sector</label>
                <select style={input} value={sector} onChange={(e) => setSector(e.target.value)}>
                  {["AI infra", "Applied AI", "AI x Bio"].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={label}>Geo</label>
                <input style={input} value={geo} onChange={(e) => setGeo(e.target.value)} maxLength={60} />
              </div>
            </div>
            <div>
              <label style={label}>Deck (PDF, up to 20 MB)</label>
              <input type="file" accept="application/pdf" onChange={(e) => setDeckFile(e.target.files?.[0] ?? null)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <label style={label}>GitHub (optional)</label>
                <input style={input} value={github} onChange={(e) => setGithub(e.target.value)} placeholder="https://github.com/…" />
              </div>
              <div>
                <label style={label}>LinkedIn (optional)</label>
                <input style={input} value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder="https://linkedin.com/in/…" />
              </div>
            </div>
            <div>
              <label style={label}>Website (optional)</label>
              <input style={input} value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://…" />
            </div>

            {err && (
              <div style={{ background: C.flagSoft, color: C.flag, padding: 10, borderRadius: 6, fontSize: 12, fontFamily: C.mono }}>
                {err}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
              <button type="button" onClick={onClose} style={{ padding: "9px 16px", borderRadius: 6, border: `1px solid ${C.line}`, background: "#fff", cursor: "pointer", fontSize: 12 }}>Cancel</button>
              <button type="submit" disabled={busy} style={{ padding: "9px 18px", borderRadius: 6, border: "none", background: C.sea, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                {busy ? "Submitting…" : "Submit application"}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
