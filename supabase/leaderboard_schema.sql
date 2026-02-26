create table if not exists public.leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('skeleton', 'muscle')),
  player_name text not null,
  score integer not null,
  max_score integer not null,
  duration_ms integer not null,
  accuracy_percent integer not null,
  created_at timestamptz not null default now()
);

create index if not exists leaderboard_mode_rank_idx
  on public.leaderboard_entries (mode, score desc, duration_ms asc, created_at asc);

create unique index if not exists leaderboard_mode_name_unique
  on public.leaderboard_entries (mode, lower(player_name));

alter table public.leaderboard_entries enable row level security;

drop policy if exists leaderboard_select_public on public.leaderboard_entries;
create policy leaderboard_select_public
  on public.leaderboard_entries
  for select
  to anon, authenticated
  using (true);
