-- Private Web Push subscriptions. Browser roles never access this table directly.
create table if not exists public.push_subscriptions (
  subscription_id uuid primary key default gen_random_uuid(),
  owner_legacy_id text not null references public.app_users(legacy_id) on delete cascade,
  owner_auth_user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (length(endpoint) between 1 and 2048),
  p256dh text not null check (length(p256dh) between 20 and 256),
  auth text not null check (length(auth) between 10 and 256),
  user_agent text not null default '' check (length(user_agent) <= 512),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

create index if not exists push_subscriptions_owner_idx
  on public.push_subscriptions(owner_auth_user_id, enabled);
create index if not exists push_subscriptions_legacy_idx
  on public.push_subscriptions(owner_legacy_id, enabled);

create or replace function public.push_subscription_upsert(
  p_auth_user_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default ''
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_legacy_id text;
begin
  select legacy_id into v_legacy_id from public.app_users
   where auth_user_id = p_auth_user_id and needs_password_reset = false limit 1;
  if v_legacy_id is null then raise exception 'account_not_linked'; end if;
  insert into public.push_subscriptions(owner_legacy_id, owner_auth_user_id, endpoint, p256dh, auth, user_agent, enabled, updated_at)
  values (v_legacy_id, p_auth_user_id, p_endpoint, p_p256dh, p_auth, coalesce(p_user_agent,''), true, now())
  on conflict (endpoint) do update set owner_legacy_id=excluded.owner_legacy_id,
    owner_auth_user_id=excluded.owner_auth_user_id, p256dh=excluded.p256dh, auth=excluded.auth,
    user_agent=excluded.user_agent, enabled=true, updated_at=now();
  return true;
end $$;

create or replace function public.push_subscription_delete(
  p_auth_user_id uuid, p_endpoint text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.push_subscriptions where owner_auth_user_id=p_auth_user_id and endpoint=p_endpoint;
  return true;
end $$;

create or replace function public.push_subscription_targets(p_target_legacy_id text)
returns table(endpoint text, p256dh text, auth text, owner_auth_user_id uuid)
language sql security definer set search_path = public, pg_temp
as $$
  select s.endpoint, s.p256dh, s.auth, s.owner_auth_user_id
  from public.push_subscriptions s
  where s.enabled and (p_target_legacy_id = 'all' or s.owner_legacy_id = p_target_legacy_id)
  order by s.updated_at desc
  limit 500;
$$;

revoke all on function public.push_subscription_upsert(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.push_subscription_delete(uuid,text) from public, anon, authenticated;
revoke all on function public.push_subscription_targets(text) from public, anon, authenticated;
grant execute on function public.push_subscription_upsert(uuid,text,text,text,text) to service_role;
grant execute on function public.push_subscription_delete(uuid,text) to service_role;
grant execute on function public.push_subscription_targets(text) to service_role;
