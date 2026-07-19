ALTER TABLE public.people_candidates
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS outreach_draft text;