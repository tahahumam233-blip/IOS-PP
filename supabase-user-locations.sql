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

create table if not exists public.user_location_history (
  id bigserial primary key,
  user_id text not null,
  user_label text not null,
  user_role text not null,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_m integer,
  heading double precision,
  speed_mps double precision,
  last_action text,
  recorded_at timestamptz not null default now()
);

grant usage on schema public to anon;
grant select, insert, update, delete on public.user_locations to anon;
grant select, insert, update, delete on public.user_location_history to anon;
grant usage, select on sequence public.user_location_history_id_seq to anon;

alter table public.user_locations enable row level security;
alter table public.user_location_history enable row level security;

drop policy if exists "Allow anon reads user locations" on public.user_locations;
drop policy if exists "Allow anon inserts user locations" on public.user_locations;
drop policy if exists "Allow anon updates user locations" on public.user_locations;
drop policy if exists "Allow anon deletes user locations" on public.user_locations;
drop policy if exists "Allow anon reads user location history" on public.user_location_history;
drop policy if exists "Allow anon inserts user location history" on public.user_location_history;
drop policy if exists "Allow anon updates user location history" on public.user_location_history;
drop policy if exists "Allow anon deletes user location history" on public.user_location_history;

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

create policy "Allow anon reads user location history"
on public.user_location_history
for select
to anon
using (true);

create policy "Allow anon inserts user location history"
on public.user_location_history
for insert
to anon
with check (true);

create policy "Allow anon updates user location history"
on public.user_location_history
for update
to anon
using (true)
with check (true);

create policy "Allow anon deletes user location history"
on public.user_location_history
for delete
to anon
using (true);

create index if not exists user_locations_updated_at_idx
on public.user_locations (updated_at desc);

create index if not exists user_location_history_user_time_idx
on public.user_location_history (user_id, recorded_at desc);

create index if not exists user_location_history_time_idx
on public.user_location_history (recorded_at desc);
