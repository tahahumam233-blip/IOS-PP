create table if not exists public.user_locations (
  user_id text primary key,
  user_label text not null,
  user_role text not null,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_m integer,
  heading double precision,
  speed_mps double precision,
  last_action text,
  updated_at timestamptz not null default now()
);

alter table public.user_locations disable row level security;

grant select, insert, update, delete on public.user_locations to anon;

drop policy if exists "Allow anon reads user locations" on public.user_locations;
drop policy if exists "Allow anon inserts user locations" on public.user_locations;
drop policy if exists "Allow anon updates user locations" on public.user_locations;
drop policy if exists "Allow anon deletes user locations" on public.user_locations;

create policy "Allow anon reads user locations"
on public.user_locations
for select
to anon
using (true);

create policy "Allow anon inserts user locations"
on public.user_locations
for insert
to anon
with check (true);

create policy "Allow anon updates user locations"
on public.user_locations
for update
to anon
using (true)
with check (true);

create policy "Allow anon deletes user locations"
on public.user_locations
for delete
to anon
using (true);

create index if not exists user_locations_updated_at_idx
on public.user_locations (updated_at desc);
