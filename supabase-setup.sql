-- Connection Game — accounts schema (TODO #23). Run once in the Supabase
-- SQL Editor. One row per user, one jsonb column per localStorage key the
-- account syncs; RLS restricts every operation to your own row (which is
-- what makes the embedded anon key safe).

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text,
  daily_log jsonb not null default '{}'::jsonb,
  shelf jsonb not null default '[]'::jsonb,
  stubs jsonb not null default '[]'::jsonb,
  favorites jsonb not null default '[]'::jsonb,
  ledger jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile" on public.profiles
  for all
  using (auth.uid() = id)
  with check (auth.uid() = id);
