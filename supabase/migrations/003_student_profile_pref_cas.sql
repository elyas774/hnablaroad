-- One narrowly scoped student self-service write for the existing notification toggle.
-- The browser cannot execute this function; Netlify calls it only after Auth verification.
begin;

alter table public.shared enable row level security;
alter table public.app_users enable row level security;
revoke all on table public.shared, public.app_users from public, anon, authenticated;

create or replace function public.student_profile_pref_cas(
  p_auth_user_id uuid,
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
  v_version bigint;
  v_raw text;
  v_users jsonb;
  v_next jsonb;
  v_matches integer;
  v_affected integer;
begin
  if p_auth_user_id is null then
    raise exception 'Authenticated identity is required';
  end if;

  select u.legacy_id into v_legacy_id
    from public.app_users u
   where u.auth_user_id = p_auth_user_id
     and not u.needs_password_reset;
  if v_legacy_id is null then
    raise exception 'Authenticated account is not linked';
  end if;

  if p_patch is null
     or jsonb_typeof(p_patch) <> 'object'
     or jsonb_object_length(p_patch) <> 1
     or not (p_patch ? 'notifPref')
     or jsonb_typeof(p_patch -> 'notifPref') <> 'boolean' then
    raise exception 'Only the boolean notifPref field may be changed';
  end if;

  select s.version, s.data ->> 'value'
    into v_version, v_raw
    from public.shared s
   where s.id = 'users'
   for update;
  if not found or v_raw is null then
    raise exception 'User state is unavailable';
  end if;
  if v_version <> coalesce(p_expected, 0) then
    return false;
  end if;

  begin
    v_users := v_raw::jsonb;
  exception when others then
    raise exception 'User state is malformed';
  end;
  if jsonb_typeof(v_users) <> 'array' then
    raise exception 'User state is malformed';
  end if;

  select count(*) into v_matches
    from jsonb_array_elements(v_users) as e(user_row)
   where e.user_row ->> 'id' = v_legacy_id;
  if v_matches <> 1 then
    raise exception 'User state identity is ambiguous';
  end if;

  select jsonb_agg(
           case when e.user_row ->> 'id' = v_legacy_id
                then e.user_row || p_patch
                else e.user_row
           end
           order by e.ordinality
         )
    into v_next
    from jsonb_array_elements(v_users) with ordinality as e(user_row, ordinality);

  update public.shared
     set data = jsonb_set(data, '{value}', to_jsonb(v_next::text), true),
         version = version + 1,
         updated_at = now()
   where id = 'users'
     and version = v_version;
  get diagnostics v_affected = row_count;
  return v_affected = 1;
end;
$$;

revoke all on function public.student_profile_pref_cas(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.student_profile_pref_cas(uuid, bigint, jsonb) to service_role;

commit;
