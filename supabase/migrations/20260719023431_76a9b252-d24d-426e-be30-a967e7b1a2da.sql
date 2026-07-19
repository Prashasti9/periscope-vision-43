
CREATE TABLE public.real_signals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'tavily',
  subject text not null default '',
  query text not null default '',
  title text not null default '',
  url text not null default '',
  content text not null default '',
  score numeric not null default 0,
  reliability numeric not null default 0.7,
  date text not null default ''
);

GRANT SELECT ON public.real_signals TO anon, authenticated;
GRANT ALL ON public.real_signals TO service_role;

ALTER TABLE public.real_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Real signals are publicly readable"
  ON public.real_signals FOR SELECT
  TO public
  USING (true);

CREATE INDEX real_signals_subject_idx ON public.real_signals (subject);
CREATE INDEX real_signals_created_at_idx ON public.real_signals (created_at DESC);
