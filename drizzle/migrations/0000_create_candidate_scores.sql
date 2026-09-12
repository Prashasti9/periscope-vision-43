CREATE TABLE public.candidate_scores (
  identity_key text PRIMARY KEY,
  score jsonb NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.candidate_scores TO anon;
GRANT SELECT ON public.candidate_scores TO authenticated;
GRANT ALL ON public.candidate_scores TO service_role;
ALTER TABLE public.candidate_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Candidate scores public read"
  ON public.candidate_scores FOR SELECT USING (true);