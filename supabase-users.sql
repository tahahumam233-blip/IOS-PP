create table if not exists public.app_users (
  id text primary key,
  password text not null,
  role text not null,
  label text not null,
  permissions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_users disable row level security;

insert into public.app_users (id, password, role, label, permissions, updated_at)
values
  (
    'admin',
    'admin2026',
    'admin',
    'Admin',
    '{"post":true,"update":true,"exchange":true,"viewAllActivity":true,"manageUsers":true}'::jsonb,
    now()
  ),
  (
    'zaki',
    'zaki2026',
    'zaki',
    'Zaki',
    '{"post":true,"update":true,"exchange":true,"viewAllActivity":false,"manageUsers":false}'::jsonb,
    now()
  )
on conflict (id) do nothing;
