create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.cleanup_ios_pp_after_2_days()
returns void
language plpgsql
security definer
as $$
begin
  -- Delete uploaded receipts, invoices, note files, and exchange text files older than 2 days.
  delete from storage.objects
  where bucket_id = 'IOS-PP- Receipts'
    and created_at < now() - interval '2 days';

  -- Delete payment, withdrawal, and exchange task records older than 2 days.
  delete from public.task_status
  where task_type in ('payment', 'withdrawal', 'exchange')
    and updated_at < now() - interval '2 days';

  -- Keep the activity log small while retaining two days of operational history.
  delete from public.activity_log
  where lower(coalesce(task_type, '')) in ('payment', 'withdrawal', 'exchange')
    and activity_time < now() - interval '2 days';
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
