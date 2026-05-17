alter table public.task_status
add column if not exists priority text default 'normal',
add column if not exists admin_note text,
add column if not exists priority_updated_by text,
add column if not exists priority_updated_at timestamptz;

update public.task_status
set priority = 'normal'
where priority is null;

alter table public.task_status
drop constraint if exists task_status_priority_check;

alter table public.task_status
add constraint task_status_priority_check
check (priority in ('normal', 'priority', 'urgent'));
