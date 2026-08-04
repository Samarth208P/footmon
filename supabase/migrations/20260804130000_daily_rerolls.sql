create table if not exists public.daily_rerolls (
  day date primary key default (timezone('Asia/Kolkata', now())::date),
  count integer not null default 0 check (count >= 0)
);

alter table public.daily_rerolls enable row level security;

drop policy if exists daily_rerolls_read on public.daily_rerolls;
create policy daily_rerolls_read on public.daily_rerolls for select using (true);

grant all on public.daily_rerolls to service_role;
grant select on public.daily_rerolls to anon, authenticated;

create or replace function public.increment_daily_rerolls()
returns void
language plpgsql
security definer
as $$
begin
  insert into public.daily_rerolls (day, count)
  values (timezone('Asia/Kolkata', now())::date, 1)
  on conflict (day) do update
  set count = daily_rerolls.count + 1;
end;
$$;
