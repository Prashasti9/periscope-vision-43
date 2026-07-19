import { createServerFn } from "@tanstack/react-start";
import { DEFAULT_THESIS, normalizeRisk, type ThesisConfig } from "./thesis";

export const getFounders = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("founders")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getPeopleCandidates = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as { limit?: number };
    return { limit: typeof v.limit === "number" ? v.limit : 200 };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("people_candidates")
      .select("*")
      .order("signal_count", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getSignals = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as { source?: string; limit?: number };
    return {
      source: typeof v.source === "string" ? v.source : "all",
      limit: typeof v.limit === "number" ? v.limit : 60,
    };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("signals")
      .select("*")
      .order("date", { ascending: false })
      .limit(data.limit);
    if (data.source !== "all") q = q.eq("source", data.source);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export const getThesisConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<ThesisConfig> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("thesis_config" as never)
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return DEFAULT_THESIS;
    const row = data as Record<string, unknown>;
    return {
      sectors: toStringArray(row.sectors),
      stages: toStringArray(row.stages),
      geographies: toStringArray(row.geographies),
      cities: toStringArray(row.cities),
      check_size:
        typeof row.check_size === "number" ? row.check_size : DEFAULT_THESIS.check_size,
      ownership_target:
        typeof row.ownership_target === "number"
          ? row.ownership_target
          : Number(row.ownership_target) || DEFAULT_THESIS.ownership_target,
      risk: normalizeRisk(row.risk),
    };
  },
);

export const saveThesisConfig = createServerFn({ method: "POST" })
  .inputValidator((input: unknown): ThesisConfig => {
    const v = (input ?? {}) as Partial<ThesisConfig>;
    return {
      sectors: toStringArray(v.sectors),
      stages: toStringArray(v.stages),
      geographies: toStringArray(v.geographies),
      cities: toStringArray(v.cities),
      check_size: Number(v.check_size) || DEFAULT_THESIS.check_size,
      ownership_target:
        Number(v.ownership_target) || DEFAULT_THESIS.ownership_target,
      risk: normalizeRisk(v.risk),
    };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("thesis_config" as never)
      .upsert({
        id: "default",
        sectors: data.sectors,
        stages: data.stages,
        geographies: data.geographies,
        cities: data.cities,
        check_size: data.check_size,
        ownership_target: data.ownership_target,
        risk: data.risk,
        updated_at: new Date().toISOString(),
      } as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
