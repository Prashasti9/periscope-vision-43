import { createServerFn } from "@tanstack/react-start";

/* Thin createServerFn wrappers around the plain logic in ./enrich.server.
   Client code calls these; server code imports the plain functions directly. */

export type {
  EnrichedSignal,
  EnrichedWebEvidence,
  EnrichedGithubProfile,
  EnrichmentResult,
} from "./enrich.server";

export const enrichCandidate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { identityKey?: unknown };
    if (typeof v?.identityKey !== "string" || !v.identityKey)
      throw new Error("identityKey required");
    return { identityKey: v.identityKey };
  })
  .handler(async ({ data }) => {
    const { runEnrichCandidate } = await import("./enrich.server");
    return runEnrichCandidate(data.identityKey);
  });

export const enrichFounder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const v = input as { founderId?: unknown };
    if (typeof v?.founderId !== "string" || !v.founderId)
      throw new Error("founderId required");
    return { founderId: v.founderId };
  })
  .handler(async ({ data }) => {
    const { runEnrichFounder } = await import("./enrich.server");
    return runEnrichFounder(data.founderId);
  });
