
## Goal
Replace the hardcoded demo memo/score paths with real OpenAI (gpt-4o) calls, using your API key stored as a secret.

## Note on architecture
This project is TanStack Start, not classic Supabase. Lovable's rules for this stack say new app-internal server logic goes in a `createServerFn` handler, not a new Supabase Edge Function. Functionally it's the same "backend endpoint the frontend calls" — the OpenAI key stays server-side, the browser never sees it — just implemented as a server function instead of an edge function. If you'd rather I force it into a `supabase/functions/*` edge function anyway, say so and I'll do that instead.

## Secret
Request `OPENAI_API_KEY` via the secret form (you paste it, it's stored server-side, never in code or the client bundle).

## Backend: `src/lib/openai.functions.ts`
Two `createServerFn` handlers, both calling `https://api.openai.com/v1/chat/completions` with `model: "gpt-4o"` and `response_format: { type: "json_object" }`. Both read `process.env.OPENAI_API_KEY` inside the handler and return structured JSON so the UI can render deterministically.

1. `generateMemo({ founderId })`
   - Loads the founder row from `founders` (via `supabaseAdmin` inside the handler).
   - System prompt: evidence-first VC analyst. Every claim must cite a signal id / claim id from the record. If a section has no evidence, output the literal string `MISSING — not in evidence` for that bullet; never invent facts or numbers.
   - Returns JSON with keys: `company_snapshot`, `investment_hypotheses`, `swot` (strengths/weaknesses/opportunities/threats arrays), `problem_and_product`, `traction_and_kpis`, `recommendation`. Each item is `{ text, citations: string[] }`.

2. `scoreCandidate({ identityKey })`
   - Loads the `people_candidates` row + all `signals` rows for that `person_or_handle` (case-insensitive match on the normalized key).
   - System prompt: score only from cited signals; if evidence for an axis is thin, return `unscorable` and a flag reason.
   - Returns JSON: `{ founder: {score, reason, unscorable}, market: {...}, idea_vs_market: {...}, sources_used: string[] }` — score is 1–10 or null when `unscorable: true`, `reason` is one sentence quoting/citing the signal(s).

Errors surfaced explicitly: 401 (bad key), 429 (rate limit), 402/insufficient_quota (billing).

## Frontend wiring in `src/routes/index.tsx`
- **Memo tab**: replace the current hardcoded memo generation with a call to `generateMemo` via `useServerFn`, rendered into the existing memo layout (COMPANY SNAPSHOT / INVESTMENT HYPOTHESES / SWOT / PROBLEM & PRODUCT / TRACTION & KPIS / RECOMMENDATION). `MISSING — not in evidence` items are rendered with the existing amber/flag styling so gaps are visibly flagged.
- **Live Signals / candidates panel** (Sourcing tab): add a "Score candidate" button on each `people_candidates` row that calls `scoreCandidate` and renders the three axes as `ScoreBand`s. Any axis returned as `unscorable` renders as a flagged chip instead of a numeric band.
- Loading, error, and empty states for both actions.

## Out of scope
- I'm not touching the six seeded founders' baseline scores/momentum/claims in the database — those remain demo data, but the memo/scoring paths that were previously hardcoded now come from OpenAI.
- Existing `askAI` (Lovable AI Gateway) helper stays where it is; only the memo/score paths move to OpenAI.

## Verification
Typecheck; then call each server function once with a real record and inspect the returned JSON shape.
