import { createServerFn } from "@tanstack/react-start";

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
