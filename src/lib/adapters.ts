/**
 * Single source of truth for converting a CandidateScore (snake_case,
 * { score, reason, unscorable, low, high }) into the Founder-shape axes
 * ({ founder, market, ideaVsMarket } each { score, trend, note, rating })
 * that PipelineView / DossierView / seed founders rows expect.
 *
 * All persistence writes (scoreFounder → founders.axes, convergeCandidate
 * → founders.axes) and all read-side normalization (rowToFounder) MUST go
 * through toDisplayAxes. Do not hand-roll this conversion elsewhere.
 */

import type { AxisScore, CandidateScore } from "./openai.functions";

export type DisplayAxis = {
  score: number | null;
  trend: string | null;
  note: string;
  rating: string | null;
};

export type DisplayAxes = {
  founder: DisplayAxis;
  market: DisplayAxis;
  ideaVsMarket: DisplayAxis;
};

const PLACEHOLDER_NOTE = "unscorable — flagged: no evidence";

function toAxis(ax: AxisScore | Partial<DisplayAxis> | null | undefined): DisplayAxis {
  if (!ax || typeof ax !== "object") {
    return { score: null, trend: null, note: PLACEHOLDER_NOTE, rating: null };
  }
  // Accept either CandidateScore AxisScore ({score, reason, unscorable}) or
  // already-DisplayAxis-shaped input ({score, trend, note, rating}).
  const anyAx = ax as Partial<AxisScore> & Partial<DisplayAxis>;
  const unscorable = "unscorable" in anyAx ? Boolean(anyAx.unscorable) : anyAx.score == null;
  const score = unscorable ? null : typeof anyAx.score === "number" ? anyAx.score : null;
  const note =
    (typeof anyAx.note === "string" && anyAx.note) ||
    (typeof anyAx.reason === "string" && anyAx.reason) ||
    PLACEHOLDER_NOTE;
  const trend =
    typeof anyAx.trend === "string" && anyAx.trend.length > 0 ? anyAx.trend : null;
  const rating = typeof anyAx.rating === "string" ? anyAx.rating : null;
  return { score, trend, note, rating };
}

/**
 * Convert a CandidateScore (or an already-DisplayAxes-shaped legacy row)
 * into DisplayAxes. Explicitly maps snake_case idea_vs_market → camelCase
 * ideaVsMarket. Always sets trend: null when no momentum history exists
 * (a single score has no direction) — the Axis type requires trend to be
 * present, not omitted.
 *
 * Dev safety: if the input has NO recognizable axis keys at all, log a
 * clear error naming the offending row instead of letting downstream
 * code TypeError on ax.trend and blank the page.
 */
export function toDisplayAxes(
  input: unknown,
  contextLabel?: string,
): DisplayAxes {
  const c = (input ?? {}) as Partial<CandidateScore> & Partial<DisplayAxes>;
  const founderAx = c.founder;
  const marketAx = c.market;
  const ivmAx =
    (c as { idea_vs_market?: AxisScore }).idea_vs_market ?? c.ideaVsMarket;

  if (!founderAx && !marketAx && !ivmAx) {
    // Never throw — render placeholders and log so the row is identifiable.
    // eslint-disable-next-line no-console
    console.error(
      `[toDisplayAxes] axes payload missing founder/market/idea_vs_market for ${
        contextLabel ?? "(unknown row)"
      }`,
      input,
    );
  }

  return {
    founder: toAxis(founderAx),
    market: toAxis(marketAx),
    ideaVsMarket: toAxis(ivmAx),
  };
}