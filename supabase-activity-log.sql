create table if not exists public.activity_log (
  id text primary key,
  activity_date date not null,
  activity_time timestamptz not null default now(),
  user_id text not null,
  user_label text not null,
  user_role text not null,
  title text not null,
  message text not null,
  status text not null,
  task_name text,
  task_type text,
  file_count integer not null default 0,
  has_note boolean not null default false
);

alter table public.activity_log disable row level security;

grant usage on schema public to anon;
grant select, insert, update, delete on public.activity_log to anon;

create index if not exists activity_log_date_time_idx
on public.activity_log (activity_date, activity_time desc);

create index if not exists activity_log_user_date_idx
on public.activity_log (user_id, activity_date, activity_time desc);
