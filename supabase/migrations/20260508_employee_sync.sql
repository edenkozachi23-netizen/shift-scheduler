-- ============================================================
-- Sync auth.users → public.users on every registration
-- Run once in Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Trigger function: fires after each new auth signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, name, role, is_active)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    COALESCE(new.raw_user_meta_data->>'role', 'employee'),
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    role = EXCLUDED.role;
  RETURN new;
END;
$$;

-- 2. Attach trigger to auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Backfill existing users (run once — safe to re-run)
INSERT INTO public.users (id, name, role, is_active)
SELECT
  id,
  COALESCE(raw_user_meta_data->>'display_name', split_part(email, '@', 1)),
  COALESCE(raw_user_meta_data->>'role', 'employee'),
  true
FROM auth.users
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role;

-- 4. Allow authenticated users to read the users table
GRANT SELECT ON public.users TO authenticated;

-- 5. Enable RLS and add read policy
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read_users" ON public.users;
CREATE POLICY "authenticated_read_users"
  ON public.users FOR SELECT
  TO authenticated
  USING (true);
