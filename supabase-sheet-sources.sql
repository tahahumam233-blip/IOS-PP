-- Secure Google Sheet source registry for IOS Payment Tracker.
--
-- This file is the canonical, idempotent database setup for the source manager.
-- It intentionally contains neither the source-admin raw key nor its SHA-256 hash.
-- Generate a 32-byte random key outside SQL, store only its lowercase SHA-256 hex
-- digest in public.app_source_admin_config, and keep the raw key in a password
-- manager. The source-admin Edge Function reads no custom admin secret.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.app_sheet_sources (
  id text primary key,
  name text not null,
  spreadsheet_id text not null,
  sheet_name text not null default 'PP',
  sheet_gid text not null default '0',
  payment_range text not null default 'A7:J200',
  withdrawal_range text not null default 'L26:N200',
  layout_key text not null default 'pp-v1',
  enabled boolean not null default true,
  config_version bigint not null default 1,
  tested_config_version bigint,
  last_test_status text not null default 'untested',
  last_tested_at timestamptz,
  last_test_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_sheet_sources_id_format
    check (id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint app_sheet_sources_name_length
    check (char_length(btrim(name)) between 1 and 80),
  constraint app_sheet_sources_spreadsheet_id_format
    check (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,200}$'),
  constraint app_sheet_sources_sheet_name_length
    check (char_length(btrim(sheet_name)) between 1 and 100),
  constraint app_sheet_sources_gid_format
    check (sheet_gid ~ '^[0-9]{1,20}$'),
  constraint app_sheet_sources_payment_range_format
    check (payment_range ~ '^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$'),
  constraint app_sheet_sources_withdrawal_range_format
    check (withdrawal_range ~ '^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$'),
  constraint app_sheet_sources_layout_key
    check (layout_key = 'pp-v1'),
  constraint app_sheet_sources_config_version
    check (config_version > 0),
  constraint app_sheet_sources_test_status
    check (last_test_status in ('untested', 'success', 'error')),
  constraint app_sheet_sources_test_version
    check (
      (last_test_status = 'untested' and tested_config_version is null)
      or
      (last_test_status in ('success', 'error') and tested_config_version = config_version)
    ),
  unique (spreadsheet_id, sheet_gid, payment_range, withdrawal_range)
);

-- Upgrade installations created by the earlier source-registry script.
alter table public.app_sheet_sources
  add column if not exists config_version bigint not null default 1;
alter table public.app_sheet_sources
  add column if not exists tested_config_version bigint;

-- Normalize the only legacy transient status before replacing its constraint.
update public.app_sheet_sources
set last_test_status = 'untested',
    last_tested_at = null,
    last_test_message = null,
    tested_config_version = null
where last_test_status = 'testing';

update public.app_sheet_sources
set tested_config_version = config_version
where last_test_status in ('success', 'error')
  and tested_config_version is distinct from config_version;

update public.app_sheet_sources
set tested_config_version = null
where last_test_status = 'untested'
  and tested_config_version is not null;

alter table public.app_sheet_sources
  drop constraint if exists app_sheet_sources_test_status;
alter table public.app_sheet_sources
  add constraint app_sheet_sources_test_status
    check (last_test_status in ('untested', 'success', 'error'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_sheet_sources'::regclass
      and conname = 'app_sheet_sources_sheet_name_length'
  ) then
    alter table public.app_sheet_sources
      add constraint app_sheet_sources_sheet_name_length
        check (char_length(btrim(sheet_name)) between 1 and 100);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_sheet_sources'::regclass
      and conname = 'app_sheet_sources_config_version'
  ) then
    alter table public.app_sheet_sources
      add constraint app_sheet_sources_config_version check (config_version > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_sheet_sources'::regclass
      and conname = 'app_sheet_sources_test_version'
  ) then
    alter table public.app_sheet_sources
      add constraint app_sheet_sources_test_version
        check (
          (last_test_status = 'untested' and tested_config_version is null)
          or
          (last_test_status in ('success', 'error') and tested_config_version = config_version)
        );
  end if;
end;
$$;

create table if not exists public.app_sheet_settings (
  id text primary key default 'global',
  active_source_id text not null references public.app_sheet_sources(id) on delete restrict,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint app_sheet_settings_singleton check (id = 'global'),
  constraint app_sheet_settings_version check (version > 0)
);

-- Admin-key configuration is deliberately not seeded. A missing row keeps the
-- admin API locked until an operator stores a generated key hash explicitly.
create table if not exists public.app_source_admin_config (
  id text primary key default 'global',
  admin_key_hash text not null,
  key_version bigint not null default 1,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_source_admin_config_singleton check (id = 'global'),
  constraint app_source_admin_config_hash check (admin_key_hash ~ '^[0-9a-f]{64}$'),
  constraint app_source_admin_config_version check (key_version > 0)
);

create table if not exists public.app_source_admin_sessions (
  token_hash text primary key,
  key_version bigint not null,
  client_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint app_source_admin_sessions_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint app_source_admin_sessions_client_hash check (client_hash ~ '^[0-9a-f]{64}$'),
  constraint app_source_admin_sessions_version check (key_version > 0),
  constraint app_source_admin_sessions_expiry check (expires_at > created_at)
);

create index if not exists app_source_admin_sessions_expiry_idx
  on public.app_source_admin_sessions (expires_at);

create table if not exists public.app_source_admin_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  outcome text not null,
  source_id text,
  detail_code text,
  client_hash text,
  created_at timestamptz not null default now(),
  constraint app_source_admin_audit_action
    check (action ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  constraint app_source_admin_audit_outcome
    check (outcome in ('success', 'denied', 'error')),
  constraint app_source_admin_audit_source_id
    check (source_id is null or source_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint app_source_admin_audit_detail_code
    check (detail_code is null or detail_code ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  constraint app_source_admin_audit_client_hash
    check (client_hash is null or client_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists app_source_admin_audit_created_idx
  on public.app_source_admin_audit (created_at desc);

create table if not exists public.app_source_admin_rate_limits (
  scope text not null,
  bucket_hash text not null,
  window_started_at timestamptz not null,
  attempt_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (scope, bucket_hash),
  constraint app_source_admin_rate_scope
    check (scope ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  constraint app_source_admin_rate_hash
    check (bucket_hash ~ '^[0-9a-f]{64}$'),
  constraint app_source_admin_rate_count check (attempt_count >= 0)
);

create index if not exists app_source_admin_rate_updated_idx
  on public.app_source_admin_rate_limits (updated_at);

create or replace function private.prepare_app_sheet_source_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'A sheet source ID cannot be changed.';
  end if;

  if row(
    new.name,
    new.spreadsheet_id,
    new.sheet_name,
    new.sheet_gid,
    new.payment_range,
    new.withdrawal_range,
    new.layout_key,
    new.enabled
  ) is distinct from row(
    old.name,
    old.spreadsheet_id,
    old.sheet_name,
    old.sheet_gid,
    old.payment_range,
    old.withdrawal_range,
    old.layout_key,
    old.enabled
  ) then
    if exists (
      select 1
      from public.app_sheet_settings
      where id = 'global' and active_source_id = old.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'active_source_protected';
    end if;
    new.config_version := old.config_version + 1;
    new.tested_config_version := null;
    new.last_test_status := 'untested';
    new.last_tested_at := null;
    new.last_test_message := null;
  else
    -- config_version is database-managed, never supplied by an API caller.
    new.config_version := old.config_version;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists app_sheet_sources_prepare_update on public.app_sheet_sources;
create trigger app_sheet_sources_prepare_update
before update on public.app_sheet_sources
for each row execute function private.prepare_app_sheet_source_update();

create or replace function private.prepare_source_admin_config_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'The source-admin configuration ID cannot be changed.';
  end if;
  if new.admin_key_hash is distinct from old.admin_key_hash then
    new.key_version := old.key_version + 1;
  else
    new.key_version := old.key_version;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.revoke_source_admin_sessions_after_key_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.admin_key_hash is distinct from old.admin_key_hash
     or new.enabled is distinct from old.enabled then
    delete from public.app_source_admin_sessions;
  end if;
  return null;
end;
$$;

drop trigger if exists app_source_admin_config_prepare_update on public.app_source_admin_config;
create trigger app_source_admin_config_prepare_update
before update on public.app_source_admin_config
for each row execute function private.prepare_source_admin_config_update();

drop trigger if exists app_source_admin_config_revoke_sessions on public.app_source_admin_config;
create trigger app_source_admin_config_revoke_sessions
after update on public.app_source_admin_config
for each row execute function private.revoke_source_admin_sessions_after_key_change();

-- This matches the current production source. ON CONFLICT deliberately preserves
-- later operator edits and makes rerunning this file safe after a Q3 cutover.
insert into public.app_sheet_sources (
  id,
  name,
  spreadsheet_id,
  sheet_name,
  sheet_gid,
  payment_range,
  withdrawal_range,
  layout_key,
  enabled,
  config_version,
  tested_config_version,
  last_test_status,
  last_tested_at,
  last_test_message
)
values (
  'soa-current',
  'SOA 2026 Q2 PP',
  '1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw',
  'PP',
  '0',
  'A7:J200',
  'L26:N200',
  'pp-v1',
  true,
  1,
  1,
  'success',
  now(),
  'Existing production source imported during setup.'
)
on conflict (id) do nothing;

insert into public.app_sheet_settings (id, active_source_id, version, updated_at)
values ('global', 'soa-current', 1, now())
on conflict (id) do nothing;

-- Anonymous and authenticated callers get one narrow read surface instead of
-- direct table access.
create or replace function public.get_active_app_sheet_source()
returns table (
  id text,
  name text,
  spreadsheet_id text,
  sheet_name text,
  sheet_gid text,
  payment_range text,
  withdrawal_range text,
  layout_key text,
  config_version bigint,
  settings_version bigint,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    s.id,
    s.name,
    s.spreadsheet_id,
    s.sheet_name,
    s.sheet_gid,
    s.payment_range,
    s.withdrawal_range,
    s.layout_key,
    s.config_version,
    st.version,
    greatest(s.updated_at, st.updated_at)
  from public.app_sheet_settings st
  join public.app_sheet_sources s on s.id = st.active_source_id
  where st.id = 'global'
    and s.enabled
  limit 1;
$$;

-- The atomic activation implementation lives in a non-exposed schema. Its
-- public-schema gateway is callable only with the Edge runtime's service role.
create or replace function private.activate_app_sheet_source(
  p_target_source_id text,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  selected_source public.app_sheet_sources%rowtype;
  next_settings public.app_sheet_settings%rowtype;
begin
  select * into selected_source
  from public.app_sheet_sources
  where id = p_target_source_id
  for share;

  if not found then
    raise exception using errcode = 'P0002', message = 'source_not_found';
  end if;
  if not selected_source.enabled then
    raise exception using errcode = 'P0001', message = 'source_disabled';
  end if;
  if selected_source.last_test_status <> 'success'
     or selected_source.tested_config_version is distinct from selected_source.config_version
     or selected_source.last_tested_at is null
     or selected_source.last_tested_at < now() - interval '30 minutes' then
    raise exception using errcode = 'P0001', message = 'source_test_required';
  end if;

  update public.app_sheet_settings
  set active_source_id = p_target_source_id,
      version = version + 1,
      updated_at = now()
  where id = 'global'
    and version = p_expected_version
  returning * into next_settings;

  if not found then
    raise exception using errcode = '40001', message = 'settings_version_conflict';
  end if;

  return jsonb_build_object(
    'activeSourceId', next_settings.active_source_id,
    'version', next_settings.version,
    'updatedAt', next_settings.updated_at
  );
end;
$$;

create or replace function public.source_admin_activate_app_sheet_source(
  p_target_source_id text,
  p_expected_version bigint
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select private.activate_app_sheet_source(p_target_source_id, p_expected_version);
$$;

create or replace function private.record_app_sheet_source_test(
  p_source_id text,
  p_config_version bigint,
  p_status text,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected integer;
begin
  if p_status not in ('success', 'error') then
    raise exception 'Invalid source test status.';
  end if;

  -- A transient retest failure must not revoke the last successful validation
  -- of the unchanged source that is already serving production. The failed
  -- attempt is still captured in the source-admin audit log.
  if p_status = 'error' and exists (
    select 1
    from public.app_sheet_sources source
    join public.app_sheet_settings settings
      on settings.id = 'global'
     and settings.active_source_id = source.id
    where source.id = p_source_id
      and source.config_version = p_config_version
      and source.last_test_status = 'success'
      and source.tested_config_version = source.config_version
  ) then
    return true;
  end if;

  update public.app_sheet_sources
  set last_test_status = p_status,
      tested_config_version = p_config_version,
      last_tested_at = now(),
      last_test_message = left(coalesce(p_message, ''), 500)
  where id = p_source_id
    and config_version = p_config_version;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.source_admin_record_app_sheet_source_test(
  p_source_id text,
  p_config_version bigint,
  p_status text,
  p_message text
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select private.record_app_sheet_source_test(
    p_source_id,
    p_config_version,
    p_status,
    p_message
  );
$$;

create or replace function private.verify_source_admin_key_hash(p_key_hash text)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select key_version
  from public.app_source_admin_config
  where id = 'global'
    and enabled
    and admin_key_hash = p_key_hash
  limit 1;
$$;

create or replace function public.source_admin_verify_key_hash(p_key_hash text)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select private.verify_source_admin_key_hash(p_key_hash);
$$;

create or replace function private.consume_source_admin_rate_limit(
  p_scope text,
  p_bucket_hash text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_block_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_row public.app_source_admin_rate_limits%rowtype;
  v_now timestamptz := now();
  next_count integer;
  retry_seconds integer;
begin
  if p_scope !~ '^[a-z][a-z0-9_.-]{1,63}$'
     or p_bucket_hash !~ '^[0-9a-f]{64}$'
     or p_max_attempts < 1 or p_max_attempts > 10000
     or p_window_seconds < 1 or p_window_seconds > 86400
     or p_block_seconds < 1 or p_block_seconds > 86400 then
    raise exception 'Invalid rate-limit configuration.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_scope || ':' || p_bucket_hash, 0));

  select * into current_row
  from public.app_source_admin_rate_limits
  where scope = p_scope and bucket_hash = p_bucket_hash
  for update;

  if found and current_row.locked_until is not null
     and current_row.locked_until > v_now then
    retry_seconds := greatest(1, ceil(extract(epoch from (current_row.locked_until - v_now)))::integer);
    return jsonb_build_object('allowed', false, 'retryAfterSeconds', retry_seconds);
  end if;

  if not found
     or current_row.window_started_at + make_interval(secs => p_window_seconds) <= v_now then
    insert into public.app_source_admin_rate_limits (
      scope, bucket_hash, window_started_at, attempt_count, locked_until, updated_at
    ) values (
      p_scope, p_bucket_hash, v_now, 1, null, v_now
    )
    on conflict (scope, bucket_hash) do update
    set window_started_at = excluded.window_started_at,
        attempt_count = excluded.attempt_count,
        locked_until = null,
        updated_at = excluded.updated_at;

    return jsonb_build_object('allowed', true, 'retryAfterSeconds', 0);
  end if;

  next_count := current_row.attempt_count + 1;
  if next_count > p_max_attempts then
    update public.app_source_admin_rate_limits
    set attempt_count = next_count,
        locked_until = v_now + make_interval(secs => p_block_seconds),
        updated_at = v_now
    where scope = p_scope and bucket_hash = p_bucket_hash;

    return jsonb_build_object('allowed', false, 'retryAfterSeconds', p_block_seconds);
  end if;

  update public.app_source_admin_rate_limits
  set attempt_count = next_count,
      locked_until = null,
      updated_at = v_now
  where scope = p_scope and bucket_hash = p_bucket_hash;

  return jsonb_build_object('allowed', true, 'retryAfterSeconds', 0);
end;
$$;

create or replace function public.source_admin_consume_rate_limit(
  p_scope text,
  p_bucket_hash text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_block_seconds integer
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select private.consume_source_admin_rate_limit(
    p_scope,
    p_bucket_hash,
    p_max_attempts,
    p_window_seconds,
    p_block_seconds
  );
$$;

-- Remove the previous insecure activation function and any inherited grants.
drop function if exists public.activate_app_sheet_source(text, bigint);

-- Source identity prevents task completion state from leaking between quarters.
alter table if exists public.task_status
  add column if not exists sheet_source_id text;

do $$
begin
  if to_regclass('public.task_status') is not null then
    execute 'create index if not exists task_status_source_date_idx
      on public.task_status (sheet_source_id, task_date, task_type)';
  end if;
end;
$$;

-- Delete any pre-existing policies before enabling deny-by-default RLS. This is
-- important when the canonical file is rerun over a partially configured project.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'app_sheet_sources',
        'app_sheet_settings',
        'app_source_admin_config',
        'app_source_admin_sessions',
        'app_source_admin_audit',
        'app_source_admin_rate_limits'
      ])
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end;
$$;

alter table public.app_sheet_sources enable row level security;
alter table public.app_sheet_sources force row level security;
alter table public.app_sheet_settings enable row level security;
alter table public.app_sheet_settings force row level security;
alter table public.app_source_admin_config enable row level security;
alter table public.app_source_admin_config force row level security;
alter table public.app_source_admin_sessions enable row level security;
alter table public.app_source_admin_sessions force row level security;
alter table public.app_source_admin_audit enable row level security;
alter table public.app_source_admin_audit force row level security;
alter table public.app_source_admin_rate_limits enable row level security;
alter table public.app_source_admin_rate_limits force row level security;

revoke all on table public.app_sheet_sources from public, anon, authenticated;
revoke all on table public.app_sheet_settings from public, anon, authenticated;
revoke all on table public.app_source_admin_config from public, anon, authenticated;
revoke all on table public.app_source_admin_sessions from public, anon, authenticated;
revoke all on table public.app_source_admin_audit from public, anon, authenticated;
revoke all on table public.app_source_admin_rate_limits from public, anon, authenticated;

revoke all on table public.app_sheet_sources from service_role;
revoke all on table public.app_sheet_settings from service_role;
revoke all on table public.app_source_admin_config from service_role;
revoke all on table public.app_source_admin_sessions from service_role;
revoke all on table public.app_source_admin_audit from service_role;
revoke all on table public.app_source_admin_rate_limits from service_role;

grant select, insert, update, delete on table public.app_sheet_sources to service_role;
-- Direct settings writes remain impossible even with the Edge service role;
-- activation goes through the security-definer transaction below.
grant select on table public.app_sheet_settings to service_role;
-- The Edge API can validate a key version, but never select the stored key hash.
grant select (id, key_version, enabled) on table public.app_source_admin_config to service_role;
grant select, insert, update, delete on table public.app_source_admin_sessions to service_role;
grant insert on table public.app_source_admin_audit to service_role;
grant delete on table public.app_source_admin_rate_limits to service_role;
grant select (updated_at) on table public.app_source_admin_rate_limits to service_role;

revoke all on function public.get_active_app_sheet_source() from public, anon, authenticated;
grant execute on function public.get_active_app_sheet_source() to anon, authenticated, service_role;

revoke all on function private.activate_app_sheet_source(text, bigint) from public, anon, authenticated;
revoke all on function private.record_app_sheet_source_test(text, bigint, text, text) from public, anon, authenticated;
revoke all on function private.verify_source_admin_key_hash(text) from public, anon, authenticated;
revoke all on function private.consume_source_admin_rate_limit(text, text, integer, integer, integer) from public, anon, authenticated;

revoke all on function public.source_admin_activate_app_sheet_source(text, bigint) from public, anon, authenticated;
revoke all on function public.source_admin_record_app_sheet_source_test(text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.source_admin_verify_key_hash(text) from public, anon, authenticated;
revoke all on function public.source_admin_consume_rate_limit(text, text, integer, integer, integer) from public, anon, authenticated;

grant execute on function public.source_admin_activate_app_sheet_source(text, bigint) to service_role;
grant execute on function public.source_admin_record_app_sheet_source_test(text, bigint, text, text) to service_role;
grant execute on function public.source_admin_verify_key_hash(text) to service_role;
grant execute on function public.source_admin_consume_rate_limit(text, text, integer, integer, integer) to service_role;
