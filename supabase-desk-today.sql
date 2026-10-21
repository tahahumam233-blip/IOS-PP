-- PayDesk "Today" tab: daily payment/withdrawal statuses, saved map places,
-- a change log, and end-of-day cash checks. Desk only for now; the phone
-- tracker does not read these tables. Safe to rerun.
--
-- Access follows the project's current model (browser-managed logins with the
-- anon key, see README "Current authentication note"). The change log is
-- insert-only for the anon role so past entries cannot be edited or removed.

create table if not exists public.desk_task_status (
  id text primary key,                 -- task_date|sheet_source_id|task_key
  task_date date not null,
  sheet_source_id text not null,
  task_key text not null,              -- type|name|occurrence, stable when rows move
  task_type text not null check (task_type in ('payment', 'withdrawal')),
  task_name text not null,
  status text not null check (status in ('pending', 'in_progress', 'done', 'collected', 'canceled')),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create index if not exists desk_task_status_day_idx
on public.desk_task_status (task_date, sheet_source_id);

create table if not exists public.desk_status_log (
  id bigserial primary key,
  task_date date not null,
  sheet_source_id text not null,
  task_key text not null,
  task_type text not null,
  task_name text not null,
  old_status text,
  new_status text not null,
  changed_by text not null,
  changed_at timestamptz not null default now()
);

create index if not exists desk_status_log_day_idx
on public.desk_status_log (task_date, changed_at desc);

create table if not exists public.desk_places (
  id text primary key,                 -- kind|normalized name
  kind text not null check (kind in ('payment', 'withdrawal')),
  name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  note text not null default '',
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.desk_cash_checks (
  id text primary key,                 -- task_date|sheet_source_id
  task_date date not null,
  sheet_source_id text not null,
  counted_iqd numeric not null,
  counted_usd numeric not null,
  expected_iqd numeric not null,
  expected_usd numeric not null,
  note text not null default '',
  checked_by text not null,
  checked_at timestamptz not null default now()
);

grant usage on schema public to anon;
grant select, insert, update on public.desk_task_status to anon;
grant select, insert on public.desk_status_log to anon;
grant usage, select on sequence public.desk_status_log_id_seq to anon;
grant select, insert, update, delete on public.desk_places to anon;
grant select, insert, update on public.desk_cash_checks to anon;

alter table public.desk_task_status enable row level security;
alter table public.desk_status_log enable row level security;
alter table public.desk_places enable row level security;
alter table public.desk_cash_checks enable row level security;

drop policy if exists "Desk reads statuses" on public.desk_task_status;
drop policy if exists "Desk writes statuses" on public.desk_task_status;
drop policy if exists "Desk updates statuses" on public.desk_task_status;
create policy "Desk reads statuses" on public.desk_task_status for select to anon using (true);
create policy "Desk writes statuses" on public.desk_task_status for insert to anon with check (true);
create policy "Desk updates statuses" on public.desk_task_status for update to anon using (true) with check (true);

drop policy if exists "Desk reads log" on public.desk_status_log;
drop policy if exists "Desk appends log" on public.desk_status_log;
create policy "Desk reads log" on public.desk_status_log for select to anon using (true);
create policy "Desk appends log" on public.desk_status_log for insert to anon with check (true);

drop policy if exists "Desk reads places" on public.desk_places;
drop policy if exists "Desk writes places" on public.desk_places;
drop policy if exists "Desk updates places" on public.desk_places;
drop policy if exists "Desk deletes places" on public.desk_places;
create policy "Desk reads places" on public.desk_places for select to anon using (true);
create policy "Desk writes places" on public.desk_places for insert to anon with check (true);
create policy "Desk updates places" on public.desk_places for update to anon using (true) with check (true);
create policy "Desk deletes places" on public.desk_places for delete to anon using (true);

drop policy if exists "Desk reads cash checks" on public.desk_cash_checks;
drop policy if exists "Desk writes cash checks" on public.desk_cash_checks;
drop policy if exists "Desk updates cash checks" on public.desk_cash_checks;
create policy "Desk reads cash checks" on public.desk_cash_checks for select to anon using (true);
create policy "Desk writes cash checks" on public.desk_cash_checks for insert to anon with check (true);
create policy "Desk updates cash checks" on public.desk_cash_checks for update to anon using (true) with check (true);
