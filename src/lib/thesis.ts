/**
 * Shared thesis-fit engine. ONE implementation drives ranking for both the
 * demo Founder rows (Pipeline "Featured examples") and the live
 * people_candidates pipeline (LivePipelineView). Pure client/server compute
 * on top of already-persisted scores — never a new OpenAI call.
 *
 * Six filters, per the challenge brief:
 *   1. sector          (largest weight, 40)
 *   2. stage           (30)
 *   3. geography       (region OR city; 15; unknown → small neutral penalty, never exclude)
 *   4. check size      (10; penalize check/stage mismatch)
 *   5. ownership target (flag-only; never scored — a rendered warning when unmet)
 *   6. risk appetite    (up to 15; Conservative penalizes cold_start, Aggressive removes penalty)
 */

export type Risk = "Conservative" | "Moderate" | "Aggressive";

export type ThesisConfig = {
  sectors: string[];
  stages: string[];
  geographies: string[]; // region names, e.g. "Europe", "North America"
  cities: string[]; // free-text city fragments
  check_size: number; // $K
  ownership_target: number; // percent
  risk: Risk;
};

export const DEFAULT_THESIS: ThesisConfig = {
  sectors: ["AI infra", "Applied AI"],
  stages: ["Pre-seed", "Seed"],
  geographies: [],
  cities: [],
  check_size: 100,
  ownership_target: 7,
  risk: "Aggressive",
};

export const ALL_REGIONS = [
  "North America",
  "Europe",
  "Asia",
  "Africa",
  "LATAM",
  "Middle East",
] as const;

// Coarse region → keyword/country/city fragments used to test a founder's
// free-text `geo`. Kept intentionally simple; unknown → neutral, never excluded.
const REGION_KEYWORDS: Record<string, string[]> = {
  "North America": [
    "usa", "u.s.", "united states", "us", "america", "canada", "mexico",
    "sf", "san francisco", "nyc", "new york", "boston", "seattle", "austin",
    "los angeles", "la", "toronto", "vancouver", "montreal", "chicago",
  ],
  Europe: [
    "uk", "united kingdom", "britain", "england", "london", "paris", "france",
    "berlin", "germany", "amsterdam", "netherlands", "madrid", "spain",
    "lisbon", "portugal", "stockholm", "sweden", "helsinki", "finland",
    "dublin", "ireland", "zurich", "switzerland", "milan", "rome", "italy",
    "warsaw", "poland", "prague", "copenhagen", "oslo", "eu", "europe",
  ],
  Asia: [
    "india", "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad",
    "china", "beijing", "shanghai", "shenzhen", "hong kong", "hk",
    "singapore", "japan", "tokyo", "korea", "seoul", "taiwan", "taipei",
    "vietnam", "hanoi", "jakarta", "indonesia", "asia",
  ],
  Africa: [
    "nigeria", "lagos", "kenya", "nairobi", "south africa", "cape town",
    "johannesburg", "egypt", "cairo", "ghana", "accra", "morocco", "africa",
  ],
  LATAM: [
    "brazil", "sao paulo", "são paulo", "rio", "argentina", "buenos aires",
    "chile", "santiago", "colombia", "bogota", "bogotá", "mexico city",
    "cdmx", "peru", "lima", "latam", "latin america",
  ],
  "Middle East": [
    "uae", "dubai", "abu dhabi", "saudi", "riyadh", "israel", "tel aviv",
    "qatar", "doha", "bahrain", "kuwait", "jordan", "amman", "middle east",
  ],
};

function regionOfGeo(geo: string): string | null {
  const g = geo.trim().toLowerCase();
  if (!g) return null;
  for (const region of ALL_REGIONS) {
    if (REGION_KEYWORDS[region].some((kw) => g.includes(kw))) return region;
  }
  return null;
}

// Rough $K per typical round — used only to flag ownership shortfalls.
const TYPICAL_ROUND_K: Record<string, number> = {
  "Pre-seed": 1500,
  Seed: 4000,
  "Series A": 15000,
  "Series B": 40000,
};

// Rough check-size fit — a $100K check is a mismatch for a $15M Series A.
function checkStagePenalty(checkK: number, stage: string): number {
  const round = TYPICAL_ROUND_K[stage];
  if (!round) return 0;
  const share = checkK / round;
  // Below 0.5% of the round → severe mismatch. Between 0.5% and 20% → fine.
  if (share < 0.005) return -8;
  if (share > 0.5) return -4; // check too big for the round
  return 0;
}

export type ThesisInput = {
  sector?: string | null;
  stage?: string | null;
  geo?: string | null;
  coldStart?: boolean;
  founderScore?: number | null; // 0-1000, optional composite
};

export type ThesisTrace = {
  fit: number; // 0-100
  why: string[]; // human-readable, one line per filter (all six always present)
  ownershipFlag: string | null; // rendered warning; null when target is achievable
};

export function thesisFit(input: ThesisInput, t: ThesisConfig): ThesisTrace {
  const why: string[] = [];
  let fit = 0;

  // 1. Sector (largest weight)
  const sector = (input.sector ?? "").trim();
  if (!sector) {
    why.push("sector: unknown — neutral");
  } else if (t.sectors.length === 0) {
    fit += 20;
    why.push(`sector: no sector filter set — neutral (${sector})`);
  } else if (t.sectors.includes(sector)) {
    fit += 40;
    why.push(`sector: ∈ thesis (${sector}) +40`);
  } else {
    why.push(`sector: outside thesis (${sector}) +0`);
  }

  // 2. Stage
  const stage = (input.stage ?? "").trim();
  if (!stage) {
    why.push("stage: unknown — neutral");
  } else if (t.stages.length === 0) {
    fit += 15;
    why.push(`stage: no stage filter set — neutral (${stage})`);
  } else if (t.stages.includes(stage)) {
    fit += 30;
    why.push(`stage: ∈ thesis (${stage}) +30`);
  } else {
    why.push(`stage: outside thesis (${stage}) +0`);
  }

  // 3. Geography — unknown is neutral (small penalty), never exclude.
  const geoStr = (input.geo ?? "").trim();
  const anyGeoFilter = t.geographies.length > 0 || t.cities.length > 0;
  if (!geoStr) {
    fit += anyGeoFilter ? 5 : 15;
    why.push("geography: unknown — neutral (small penalty)");
  } else if (!anyGeoFilter) {
    fit += 15;
    why.push(`geography: no geo filter set — neutral (${geoStr})`);
  } else {
    const geoLower = geoStr.toLowerCase();
    const cityMatch = t.cities.find((c) =>
      c.trim() && geoLower.includes(c.trim().toLowerCase()),
    );
    const region = regionOfGeo(geoStr);
    const regionMatch = region && t.geographies.includes(region);
    if (cityMatch) {
      fit += 15;
      why.push(`geography: city match "${cityMatch}" in ${geoStr} +15`);
    } else if (regionMatch) {
      fit += 15;
      why.push(`geography: ${geoStr} ∈ ${region} +15`);
    } else {
      why.push(`geography: ${geoStr} outside thesis +0`);
    }
  }

  // 4. Check size vs stage
  if (!stage) {
    fit += 5;
    why.push("check size: no stage — neutral");
  } else {
    const pen = checkStagePenalty(t.check_size, stage);
    const base = 10 + pen; // baseline 10, penalized on mismatch
    fit += Math.max(0, base);
    if (pen < 0) {
      why.push(
        `check size: $${t.check_size}K vs ${stage} typical round — mismatch ${pen}`,
      );
    } else {
      why.push(`check size: $${t.check_size}K fits ${stage} +10`);
    }
  }

  // 5. Ownership target — flag only, does not affect fit.
  let ownershipFlag: string | null = null;
  const round = stage ? TYPICAL_ROUND_K[stage] : null;
  if (round) {
    const impliedPct = (t.check_size / round) * 100;
    if (impliedPct < t.ownership_target) {
      ownershipFlag = `ownership target likely unmet — $${t.check_size}K at ${stage} implies ~${impliedPct.toFixed(1)}% vs ${t.ownership_target}% target`;
      why.push(
        `ownership: implied ~${impliedPct.toFixed(1)}% < target ${t.ownership_target}% — flagged`,
      );
    } else {
      why.push(
        `ownership: implied ~${impliedPct.toFixed(1)}% ≥ target ${t.ownership_target}%`,
      );
    }
  } else {
    why.push("ownership: stage unknown — cannot compute implied %");
  }

  // 6. Risk appetite vs cold-start
  const cold = Boolean(input.coldStart);
  if (t.risk === "Aggressive") {
    fit += 15;
    why.push(
      cold
        ? "risk: Aggressive — cold-start allowed +15"
        : "risk: Aggressive — track record still credited +15",
    );
  } else if (t.risk === "Moderate") {
    if (cold) {
      fit += 5;
      why.push("risk: Moderate — cold-start lightly penalized +5");
    } else {
      fit += 12;
      why.push("risk: Moderate — track record preferred +12");
    }
  } else {
    // Conservative
    if (cold) {
      why.push("risk: Conservative — cold-start penalized +0");
    } else {
      fit += 15;
      why.push("risk: Conservative — track record required +15");
    }
  }

  // Small optional credit for a persisted composite founder score.
  if (typeof input.founderScore === "number" && input.founderScore > 0) {
    const bonus = Math.round((input.founderScore / 1000) * 10);
    fit += bonus;
    why.push(`composite founder score ${input.founderScore}/1000 → +${bonus}`);
  }

  return { fit: Math.max(0, Math.min(100, fit)), why, ownershipFlag };
}

// Best-effort mapping from a legacy risk string (old UI value) to the new enum.
export function normalizeRisk(v: unknown): Risk {
  if (typeof v !== "string") return "Aggressive";
  const s = v.toLowerCase();
  if (s.startsWith("conservative")) return "Conservative";
  if (s.startsWith("moderate")) return "Moderate";
  // "High — pre-track-record OK", "Aggressive", anything else → Aggressive
  return "Aggressive";
}