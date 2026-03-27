-- Run this in Supabase SQL Editor to create the user_profiles table
-- Dashboard: https://supabase.com/dashboard → your project → SQL Editor

CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  session_token text,
  profile_data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for fast login lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles (email);

-- Allow the anon key to read/write (since we auth via our serverless function)
-- If you have RLS enabled, add this policy:
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all via anon key" ON user_profiles
  FOR ALL
  USING (true)
  WITH CHECK (true);
