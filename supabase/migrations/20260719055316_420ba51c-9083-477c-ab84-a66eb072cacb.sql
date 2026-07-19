-- Restrict founders to authenticated users only
DROP POLICY IF EXISTS "Founders are publicly readable" ON public.founders;
REVOKE SELECT ON public.founders FROM anon;
GRANT SELECT ON public.founders TO authenticated;
CREATE POLICY "Founders readable by authenticated users"
  ON public.founders FOR SELECT TO authenticated USING (true);

-- Restrict people_candidates
DROP POLICY IF EXISTS "People candidates are publicly readable" ON public.people_candidates;
REVOKE SELECT ON public.people_candidates FROM anon;
GRANT SELECT ON public.people_candidates TO authenticated;
CREATE POLICY "People candidates readable by authenticated users"
  ON public.people_candidates FOR SELECT TO authenticated USING (true);

-- Restrict real_signals
DROP POLICY IF EXISTS "Real signals are publicly readable" ON public.real_signals;
REVOKE SELECT ON public.real_signals FROM anon;
GRANT SELECT ON public.real_signals TO authenticated;
CREATE POLICY "Real signals readable by authenticated users"
  ON public.real_signals FOR SELECT TO authenticated USING (true);

-- Restrict signals
DROP POLICY IF EXISTS "Signals are publicly readable" ON public.signals;
REVOKE SELECT ON public.signals FROM anon;
GRANT SELECT ON public.signals TO authenticated;
CREATE POLICY "Signals readable by authenticated users"
  ON public.signals FOR SELECT TO authenticated USING (true);

-- Storage RLS for 'decks' bucket: authenticated-only access
CREATE POLICY "Authenticated users can read decks"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'decks');

CREATE POLICY "Authenticated users can upload decks"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'decks' AND owner = auth.uid());

CREATE POLICY "Owners can update their deck files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'decks' AND owner = auth.uid())
  WITH CHECK (bucket_id = 'decks' AND owner = auth.uid());

CREATE POLICY "Owners can delete their deck files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'decks' AND owner = auth.uid());
