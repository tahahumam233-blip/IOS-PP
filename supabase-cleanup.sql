create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.cleanup_ios_pp_after_2_days()
returns table (
  deleted_storage_objects integer,
  deleted_task_status_rows integer,
  deleted_activity_log_rows integer
)
language plpgsql
security definer
as $$
declare
  storage_count integer := 0;
  task_count integer := 0;
  activity_count integer := 0;
begin
  -- Delete uploaded receipts, invoices, note files, and exchange text files older than 2 days.
  with deleted as (
    delete from storage.objects
    where bucket_id = 'IOS-PP- Receipts'
      and created_at < now() - interval '2 days'
    returning id
  )
  select count(*) into storage_count from deleted;

  -- Delete payment, withdrawal, and exchange task records older than 2 days.
  with deleted as (
    delete from public.task_status
    where task_type in ('payment', 'withdrawal', 'exchange')
      and updated_at < now() - interval '2 days'
    returning id
  )
  select count(*) into task_count from deleted;

  -- Keep the activity log small while retaining two days of operational history.
  with deleted as (
    delete from public.activity_log
    where lower(coalesce(task_type, '')) in ('payment', 'withdrawal', 'exchange')
      and activity_time < now() - interval '2 days'
    returning id
  )
  select count(*) into activity_count from deleted;

  deleted_storage_objects := storage_count;
  deleted_task_status_rows := task_count;
  deleted_activity_log_rows := activity_count;
  return next;
end;
$$;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'cleanup-ios-pp-after-2-days'
  ) then
    perform cron.unschedule('cleanup-ios-pp-after-2-days');
  end if;
end;
$$;

-- Runs every day at 00:05 Baghdad time, which is 21:05 UTC.
select cron.schedule(
  'cleanup-ios-pp-after-2-days',
  '5 21 * * *',
  $$
  select public.cleanup_ios_pp_after_2_days();
  $$
);

-- Optional manual test:
-- Run this anytime to clean immediately and see how many rows/files were deleted.
-- select * from public.cleanup_ios_pp_after_2_days();

-- Optional dry-run counts before cleanup:
-- select count(*) as old_storage_objects
-- from storage.objects
-- where bucket_id = 'IOS-PP- Receipts'
--   and created_at < now() - interval '2 days';
--
-- select count(*) as old_task_status_rows
-- from public.task_status
-- where task_type in ('payment', 'withdrawal', 'exchange')
--   and updated_at < now() - interval '2 days';
--
-- select count(*) as old_activity_log_rows
-- from public.activity_log
-- where lower(coalesce(task_type, '')) in ('payment', 'withdrawal', 'exchange')
--   and activity_time < now() - interval '2 days';
