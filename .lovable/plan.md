## Goal
Make the Thesis Engine filter bar actually exclude non-matching outbound `people_candidates` in `LivePipelineView`. Founders path untouched.

## Note on current state
The previous turn already added `sector`, `stage`, `geo` columns to `people_candidates` and folded classification into `scoreCandidate`. This plan supersedes that: it adds the two missing ask columns, and splits classification out into a cheap dedicated call so scoring cost/latency isn't affected.

## 1. Migration — add ask columns
`people_candidates` already has `sector`, `stage`, `geo` (nullable). Add the two missing ones, also nullable, no default, no backfill:

```sql
ALTER TABLE public.people_candidates
  ADD COLUMN check_ask integer,
  ADD COLUMN ownership_ask numeric;
```

Existing reads keep working — new columns are nullable and additive.

## 2. New `classifyCandidate` server fn in `src/lib/openai.functions.ts`
- Separate `createServerFn` from `scoreCandidate`, using the existing cheap `SCREEN_MODEL` (same one `screenCandidate` uses) — never the expensive scorer.
- Input: `{ identityKey }`. Load the same evidence bundle `scoreCandidate` already assembles (signals rows + GitHub enrichment + Tavily web evidence via existing helpers — reuse, don't duplicate).
- Prompt returns strict JSON: `{ sector, stage, geo, checkAsk, ownershipAsk }`. System prompt hard rule: **return `null` for any field the evidence doesn't clearly state or strongly imply — never infer, never estimate**. Parse defensively (same try/catch + JSON-extract pattern used by `scoreCandidate`).
- `UPDATE public.people_candidates` for that `identity_key` with `sector`, `stage`, `geo`, `check_ask`, `ownership_ask` — writing NULLs through as NULL.
- Remove the sector/stage/geo classification pass currently inside `scoreCandidate` (added in the prior turn) so we don't double-classify with the expensive model.

## 3. Wire it into `LivePipelineView`'s scoring flow
Where `runScore(candidate)` is called today, also fire `classifyCandidate({ data: { identityKey } })` — in parallel, isolated `try/catch`, no blocking of the score UI. Applies to both the auto-scoring loop and the manual "Override & score" path. No new user-visible button.

## 4. `getPeopleCandidates` in `src/lib/data.functions.ts`
Current select is `*`, so `check_ask` / `ownership_ask` come through automatically once the migration lands and types regenerate. Confirm and leave as `*` (or make the column list explicit if we prefer — same result).

## 5. `PeopleCandidate` type in `src/routes/index.tsx`
Extend the type (already has sector/stage/geo from prior turn):
```
checkAsk: number | null;
ownershipAsk: number | null;
```
Update the row → type mapping to translate `check_ask` → `checkAsk`, `ownership_ask` → `ownershipAsk`.

## 6. `candidateMatchesThesis` helper
Add near `DEFAULT_THESIS` with the exact clause structure the user specified — a null field always passes that clause; only a populated, conflicting field excludes. Risk clause uses `founder_score.coldStart` and only fails when thesis risk is not "High…". Replaces the prior turn's generic `thesisMatches` for candidates; the founder-side filter stays as-is.

## 7. `LivePipelineView` prop
Signature becomes `LivePipelineView({ thesis }: { thesis: typeof DEFAULT_THESIS })`. Call site in `Periscope` changes from `<LivePipelineView />` to `<LivePipelineView thesis={thesis} />` using the existing thesis state.

## 8. Rendering
- Split candidates into three buckets, applied to the post-scoring list:
  1. `pass = screened[key]?.pass !== false && candidateMatchesThesis(c, thesis)` → main list.
  2. `screened[key]?.pass === false` → existing "not advanced / screened out" collapsible (unchanged).
  3. Not screened out but `!candidateMatchesThesis` → new **"outside current thesis — N"** collapsible, distinct from #2.
- Count badge above main list: `"N of M candidates match current thesis"` (mirroring the founders badge).
- Re-runs on every thesis change (already reactive via the prop).

## Out of scope
`founders`, `ranked`, `ThesisView`'s UI, `signals`, `real_signals` — untouched.

## Verification
Typecheck. Then in the running app: change a thesis dropdown, confirm the badge count and the "outside current thesis" bucket update; confirm candidates with all-null classification stay in the main list (null = pass).
