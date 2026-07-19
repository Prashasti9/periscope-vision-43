import { createServerFn } from "@tanstack/react-start";

/* submitApplication — inbound intake for the Apply flow.
   Uploads a deck PDF to the `decks` storage bucket, inserts a founders
   row (track='inbound') with placeholder scoring shapes, seeds a
   real_signals row so the deck + links become scoring evidence, then
   kicks off scoreFounder (fire-and-forget). */

export type ApplicationInput = {
  company: string;
  oneLiner?: string;
  founderName: string;
  stage?: string;
  sector?: string;
  geo?: string;
  links?: { github?: string; linkedin?: string; site?: string };
  deckBase64?: string; // no data: prefix; raw base64
  deckFilename?: string;
};

function newId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `inbound-${Date.now().toString(36)}-${rand}`;
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const submitApplication = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as ApplicationInput;
    if (typeof v.company !== "string" || !v.company.trim())
      throw new Error("company required");
    if (typeof v.founderName !== "string" || !v.founderName.trim())
      throw new Error("founderName required");
    return {
      company: v.company.trim(),
      oneLiner: (v.oneLiner ?? "").trim(),
      founderName: v.founderName.trim(),
      stage: (v.stage ?? "Pre-seed").trim(),
      sector: (v.sector ?? "Applied AI").trim(),
      geo: (v.geo ?? "Global").trim(),
      links: v.links ?? {},
      deckBase64: v.deckBase64,
      deckFilename: v.deckFilename,
    };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    const id = newId();

    // 1. Upload deck (optional).
    let deckUrl: string | null = null;
    let deckPath: string | null = null;
    if (data.deckBase64 && data.deckFilename) {
      const bytes = decodeBase64(data.deckBase64);
      const safeName = data.deckFilename.replace(/[^A-Za-z0-9._-]/g, "_");
      deckPath = `${id}/${safeName}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from("decks")
        .upload(deckPath, bytes, {
          contentType: "application/pdf",
          upsert: false,
        });
      if (upErr) throw new Error(`Deck upload failed: ${upErr.message}`);
      // 7-day signed URL for viewing
      const { data: signed } = await supabaseAdmin.storage
        .from("decks")
        .createSignedUrl(deckPath, 60 * 60 * 24 * 7);
      deckUrl = signed?.signedUrl ?? null;
    }

    // 2. Insert founders row with placeholders (axes / founder_score NOT NULL).
    const placeholderAxis = { score: null, trend: null, note: "awaiting scoring" };
    const founderRow = {
      id,
      name: data.founderName,
      company: data.company,
      one_liner: data.oneLiner || "Inbound application — awaiting screening.",
      track: "inbound",
      stage: data.stage,
      geo: data.geo,
      sector: data.sector,
      accelerator: null,
      prior_vc: false,
      tags: ["inbound", "unscreened"] as unknown as never,
      founder_score: {
        value: 0,
        low: 0,
        high: 0,
        trend: "flat",
        coldStart: true,
      } as unknown as never,
      axes: {
        founder: placeholderAxis,
        market: placeholderAxis,
        ideaVsMarket: placeholderAxis,
      } as unknown as never,
      signals: [] as unknown as never,
      claims: [] as unknown as never,
      gaps: ["Not yet screened"] as unknown as never,
      momentum: [] as unknown as never,
      sort_order: 999,
    };
    const { error: insErr } = await supabaseAdmin
      .from("founders")
      .insert(founderRow);
    if (insErr) throw new Error(`Insert founder: ${insErr.message}`);

    // 3. Seed a real_signals row so scoreFounder has starting evidence.
    const subject = `founder:${id}`;
    const today = new Date().toISOString().slice(0, 10);
    const linkLines = [
      data.links?.github ? `GitHub: ${data.links.github}` : "",
      data.links?.linkedin ? `LinkedIn: ${data.links.linkedin}` : "",
      data.links?.site ? `Site: ${data.links.site}` : "",
      deckUrl ? `Deck (signed URL): ${deckUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const seedContent = [
      `Inbound application intake.`,
      `Founder: ${data.founderName}`,
      `Company: ${data.company}`,
      `One-liner: ${data.oneLiner || "(none provided)"}`,
      `Stage: ${data.stage} · Sector: ${data.sector} · Geo: ${data.geo}`,
      linkLines,
    ]
      .filter(Boolean)
      .join("\n");

    await supabaseAdmin.from("real_signals").insert({
      source: "application",
      subject,
      query: `application:${id}`,
      title: `${data.company} — inbound application`,
      url: deckUrl ?? data.links?.site ?? "",
      content: seedContent,
      score: 1,
      reliability: 0.9,
      date: today,
    });

    return {
      id,
      deckUrl,
      deckPath,
    };
  });

/* convergeCandidate — outbound Activate → Converge.
   Takes an identity_key from people_candidates plus a drafted outreach
   email, inserts a founders row with track='outbound' mirroring the
   F-0151 seed shape (company='(unnamed — pre-application)', axes as a
   thin signal-only rating, momentum empty, gaps flagging no application
   yet), stamps activated_at + outreach_draft onto people_candidates so
   the same person cannot be double-activated. Idempotent: if already
   activated, returns the existing founder id. */

export type ConvergeInput = { identityKey: string; outreachDraft: string };

export const convergeCandidate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = (input ?? {}) as ConvergeInput;
    if (typeof v.identityKey !== "string" || !v.identityKey.trim())
      throw new Error("identityKey required");
    if (typeof v.outreachDraft !== "string" || !v.outreachDraft.trim())
      throw new Error("outreachDraft required");
    return { identityKey: v.identityKey.trim(), outreachDraft: v.outreachDraft };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );

    // 1. Load candidate row.
    const { data: cand, error: candErr } = await supabaseAdmin
      .from("people_candidates")
      .select("*")
      .eq("identity_key", data.identityKey)
      .maybeSingle();
    if (candErr) throw new Error(`Load candidate: ${candErr.message}`);
    if (!cand) throw new Error(`No people_candidates row for ${data.identityKey}`);

    // 2. Idempotency — if already activated, return the existing founder.
    if (cand.activated_at) {
      const { data: existing } = await supabaseAdmin
        .from("founders")
        .select("id")
        .eq("id", `OB-${data.identityKey}`)
        .maybeSingle();
      if (existing) {
        return {
          id: existing.id,
          alreadyActivated: true,
          activatedAt: cand.activated_at,
        };
      }
    }

    // 3. Load raw signals for this candidate (best-effort).
    const handleLike = cand.person_or_handle;
    const { data: sigRows } = await supabaseAdmin
      .from("signals")
      .select("signal_id, source, text, date, reliability, url")
      .eq("person_or_handle", handleLike)
      .limit(6);

    const signalsJson = (sigRows ?? []).map((s) => ({
      id: s.signal_id,
      src: s.source,
      ts: s.date,
      text: s.text,
      conf: Number(s.reliability ?? 0.7),
    }));

    // 4. Build founders row mirroring F-0151 seed shape.
    const id = `OB-${data.identityKey}`;
    const axes = (cand.axes ?? {
      founder: {
        score: null,
        trend: null,
        note: "Signal-only profile — awaiting scoring after outreach.",
      },
      market: {
        score: null,
        trend: null,
        note: "Unscorable pre-application — flagged, not guessed.",
      },
      ideaVsMarket: {
        score: null,
        trend: null,
        note: "Unscorable pre-application — flagged, not guessed.",
      },
    }) as unknown;

    const founderScore = (cand.founder_score ?? {
      value: 0,
      low: 0,
      high: 0,
      trend: "flat",
      coldStart: true,
    }) as unknown;

    const momentum = (cand.momentum ?? []) as unknown;

    const founderRow = {
      id,
      name: handleLike,
      company: "(unnamed — pre-application)",
      one_liner:
        (cand.companies ? `Inferred from public work: ${cand.companies}` : null) ??
        "Outbound-sourced — inferred from public work.",
      track: "outbound",
      stage: "Pre-seed",
      geo: "Global",
      sector: "Applied AI",
      accelerator: null,
      prior_vc: false,
      tags: ["outbound-sourced", "not yet applied"] as unknown as never,
      founder_score: founderScore as never,
      axes: axes as never,
      signals: signalsJson as unknown as never,
      claims: [] as unknown as never,
      gaps: [
        "No application yet — Activated (cold outreach, not cold investment)",
      ] as unknown as never,
      momentum: momentum as never,
      sort_order: 999,
    };

    const { error: insErr } = await supabaseAdmin
      .from("founders")
      .upsert(founderRow, { onConflict: "id" });
    if (insErr) throw new Error(`Insert founder: ${insErr.message}`);

    // 5. Stamp candidate row.
    const nowIso = new Date().toISOString();
    await supabaseAdmin
      .from("people_candidates")
      .update({
        activated_at: nowIso,
        outreach_draft: data.outreachDraft,
      })
      .eq("identity_key", data.identityKey);

    // 6. Seed a real_signals row so the founders row has starting evidence
    //    identical to the inbound application intake pattern.
    await supabaseAdmin.from("real_signals").insert({
      source: "outreach",
      subject: `founder:${id}`,
      query: `activate:${data.identityKey}`,
      title: `Outbound activation — @${handleLike}`,
      url: "",
      content:
        `Cold outreach drafted and marked activated at ${nowIso}.\n\n` +
        `Sources present: ${cand.sources}\n` +
        `Companies inferred: ${cand.companies || "(none)"}\n\n` +
        `--- outreach draft ---\n${data.outreachDraft}`,
      score: 1,
      reliability: 0.9,
      date: nowIso.slice(0, 10),
    });

    return { id, alreadyActivated: false, activatedAt: nowIso };
  });