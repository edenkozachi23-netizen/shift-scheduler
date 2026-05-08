-- Published weeks table
-- Tracks which weeks have been officially published by the manager.
-- Run once in Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS public.published_weeks (
  week_start  date        PRIMARY KEY,
  published_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.published_weeks TO authenticated;
ALTER TABLE public.published_weeks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read_published" ON public.published_weeks;
CREATE POLICY "authenticated_read_published"
  ON public.published_weeks FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_insert_published" ON public.published_weeks;
CREATE POLICY "authenticated_insert_published"
  ON public.published_weeks FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_delete_published" ON public.published_weeks;
CREATE POLICY "authenticated_delete_published"
  ON public.published_weeks FOR DELETE TO authenticated USING (true);

-- Also allow managers to update public.users (for employee management)
DROP POLICY IF EXISTS "manager_update_users" ON public.users;
CREATE POLICY "manager_update_users"
  ON public.users FOR UPDATE TO authenticated USING (true);
