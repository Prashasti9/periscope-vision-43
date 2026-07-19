
ALTER TABLE public.people_candidates
  ADD COLUMN IF NOT EXISTS founder_score jsonb,
  ADD COLUMN IF NOT EXISTS axes jsonb,
  ADD COLUMN IF NOT EXISTS momentum jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scored_at timestamptz;
