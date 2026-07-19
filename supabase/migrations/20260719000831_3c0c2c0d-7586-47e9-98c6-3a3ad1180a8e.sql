
CREATE TABLE public.signals (
  signal_id text PRIMARY KEY,
  source text NOT NULL,
  person_or_handle text NOT NULL DEFAULT '',
  company text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  date text NOT NULL DEFAULT '',
  reliability numeric NOT NULL DEFAULT 0,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.signals TO anon, authenticated;
GRANT ALL ON public.signals TO service_role;
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signals are publicly readable" ON public.signals FOR SELECT USING (true);

CREATE TABLE public.people_candidates (
  identity_key text PRIMARY KEY,
  person_or_handle text NOT NULL,
  source_count integer NOT NULL DEFAULT 0,
  sources text NOT NULL DEFAULT '',
  companies text NOT NULL DEFAULT '',
  signal_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.people_candidates TO anon, authenticated;
GRANT ALL ON public.people_candidates TO service_role;
ALTER TABLE public.people_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "People candidates are publicly readable" ON public.people_candidates FOR SELECT USING (true);

CREATE INDEX signals_source_idx ON public.signals (source);
CREATE INDEX signals_date_idx ON public.signals (date DESC);
CREATE INDEX people_candidates_source_count_idx ON public.people_candidates (source_count DESC, signal_count DESC);
