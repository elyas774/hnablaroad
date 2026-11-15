-- Service-side authorization primitive for the Netlify app-data function.
-- This does not grant table access or RPC execution to browser roles.
-- The server must first verify the Supabase access token, then pass its UUID.

begin;

-- Reassert the browser-access boundary even if project grants drifted after baseline setup.
alter table public.shared enable row level security;
alter table public.chat_messages enable row level security;
alter table public.app_users enable row level security;
revoke all on table public.shared, public.chat_messages, public.app_users from public, anon, authenticated;

create or replace function public.leader_shared_cas(
  p_auth_user_id uuid,
  p_id text,
  p_expected bigint,
  p_data jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_legacy_id text;
  v_leader_raw text;
  v_leader_id text;
  affected integer;
begin
  if p_auth_user_id is null or p_id is null or length(p_id) < 1 or length(p_id) > 160 then
    raise exception 'Invalid actor or document';
  end if;
  if p_id = 'weekLeaderId' then
    raise exception 'Leader identity is system-managed';
  end if;

  select u.legacy_id into v_legacy_id
    from public.app_users u
   where u.auth_user_id = p_auth_user_id;
  if v_legacy_id is null then
    raise exception 'Authenticated account is not linked';
  end if;

  select s.data ->> 'value' into v_leader_raw
    from public.shared s
   where s.id = 'weekLeaderId';
  if v_leader_raw is null then
    raise exception 'Leader identity is unavailable';
  end if;
  begin
    v_leader_id := (v_leader_raw::jsonb #>> '{}');
  exception when others then
    v_leader_id := v_leader_raw;
  end;
  if v_legacy_id <> v_leader_id then
    raise exception 'Current leader required';
  end if;

  update public.shared
     set data = p_data,
         version = version + 1,
         updated_at = now()
   where id = p_id and version = coalesce(p_expected, 0);
  get diagnostics affected = row_count;
  if affected = 1 then return true; end if;

  if coalesce(p_expected, 0) = 0 then
    insert into public.shared(id, data, version, updated_at)
    values (p_id, p_data, 1, now())
    on conflict (id) do nothing;
    get diagnostics affected = row_count;
    return affected = 1;
  end if;
  return false;
end;
$$;

create or replace function public.leader_shared_patch(
  p_auth_user_id uuid,
  p_id text,
  p_expected bigint,
  p_patch jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_legacy_id text;
  v_leader_raw text;
  v_leader_id text;
  affected integer;
begin
  if p_auth_user_id is null or p_id is null or length(p_id) < 1 or length(p_id) > 160 or p_id = 'weekLeaderId' then
    raise exception 'Invalid actor or protected document';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Patch must be a JSON object';
  end if;

  select u.legacy_id into v_legacy_id
    from public.app_users u
   where u.auth_user_id = p_auth_user_id;
  if v_legacy_id is null then raise exception 'Authenticated account is not linked'; end if;

  select s.data ->> 'value' into v_leader_raw
    from public.shared s
   where s.id = 'weekLeaderId';
  if v_leader_raw is null then raise exception 'Leader identity is unavailable'; end if;
  begin
    v_leader_id := (v_leader_raw::jsonb #>> '{}');
  exception when others then
    v_leader_id := v_leader_raw;
  end;
  if v_legacy_id <> v_leader_id then raise exception 'Current leader required'; end if;

  update public.shared
     set data = data || p_patch,
         version = version + 1,
         updated_at = now()
   where id = p_id and version = coalesce(p_expected, 0);
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.chat_seen_server(
  p_auth_user_id uuid,
  p_ids text[]
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_legacy_id text;
  affected integer;
begin
  if p_auth_user_id is null then raise exception 'Invalid actor'; end if;
  select u.legacy_id into v_legacy_id
    from public.app_users u
   where u.auth_user_id = p_auth_user_id;
  if v_legacy_id is null then raise exception 'Authenticated account is not linked'; end if;

  update public.chat_messages m
     set data = jsonb_set(
       m.data,
       '{seenBy}',
       (case when jsonb_typeof(m.data -> 'seenBy') = 'array'
             then m.data -> 'seenBy' else '[]'::jsonb end) || jsonb_build_array(v_legacy_id),
       true
     ),
     version = version + 1,
     updated_at = now()
   where m.id = any(coalesce(p_ids, array[]::text[]))
     and coalesce(m.data ->> 'userId', '') <> v_legacy_id
     and not coalesce((m.data -> 'seenBy') ? v_legacy_id, false);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.leader_shared_cas(uuid, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.leader_shared_cas(uuid, text, bigint, jsonb) to service_role;
revoke all on function public.leader_shared_patch(uuid, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.leader_shared_patch(uuid, text, bigint, jsonb) to service_role;
revoke all on function public.chat_seen_server(uuid, text[]) from public, anon, authenticated;
grant execute on function public.chat_seen_server(uuid, text[]) to service_role;

commit;
