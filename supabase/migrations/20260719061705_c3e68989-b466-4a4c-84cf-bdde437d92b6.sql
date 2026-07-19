CREATE TABLE IF NOT EXISTS public.thesis_config (
  id text PRIMARY KEY DEFAULT 'default',
  sectors jsonb NOT NULL DEFAULT '["AI infra","Applied AI"]'::jsonb,
  stages jsonb NOT NULL DEFAULT '["Pre-seed","Seed"]'::jsonb,
  geographies jsonb NOT NULL DEFAULT '[]'::jsonb,
  cities jsonb NOT NULL DEFAULT '[]'::jsonb,
  check_size integer NOT NULL DEFAULT 100,
  ownership_target numeric NOT NULL DEFAULT 7,
  risk text NOT NULL DEFAULT 'Aggressive',
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.thesis_config TO authenticated;
GRANT ALL ON public.thesis_config TO service_role;

ALTER TABLE public.thesis_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Thesis config readable by authenticated"
  ON public.thesis_config FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Thesis config writable by authenticated"
  ON public.thesis_config FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Thesis config insertable by authenticated"
  ON public.thesis_config FOR INSERT
  TO authenticated WITH CHECK (true);

INSERT INTO public.thesis_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;