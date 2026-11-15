-- Student notification read markers: only the authenticated student's own readBy entry.
-- The browser cannot execute this function; the Netlify gateway calls it after Auth verification.
begin;

alter table public.shared enable row level security;
alter table public.app_users enable row level security;
revoke all on table public.shared, public.app_users from public, anon, authenticated;

create or replace function public.student_notifications_seen_cas(
  p_auth_user_id uuid,
  p_expected bigint,
  p_ids text[]
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
  v_notifications jsonb;
  v_next jsonb;
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
    raise exception 'Authenticated account is not linked or password reset is pending';
  end if;

  if p_ids is null
     or coalesce(array_length(p_ids, 1), 0) < 1
     or array_length(p_ids, 1) > 300
     or exists (
       select 1 from unnest(p_ids) as supplied(id)
        where supplied.id is null or length(supplied.id) < 1 or length(supplied.id) > 160
     ) then
    raise exception 'Invalid notification identifiers';
  end if;

  select s.version, s.data ->> 'value'
    into v_version, v_raw
    from public.shared s
   where s.id = 'notifications'
   for update;
  if not found or v_raw is null then
    raise exception 'Notification state is unavailable';
  end if;
  if v_version <> coalesce(p_expected, 0) then
    return false;
  end if;

  begin
    v_notifications := v_raw::jsonb;
  exception when others then
    raise exception 'Notification state is malformed';
  end;
  if jsonb_typeof(v_notifications) <> 'array' then
    raise exception 'Notification state is malformed';
  end if;

  select jsonb_agg(
           case
             when e.notification ->> 'id' = any(p_ids)
              and (e.notification ->> 'targetId' = 'all' or e.notification ->> 'targetId' = v_legacy_id)
             then jsonb_set(
               e.notification,
               '{readBy}',
               (case when jsonb_typeof(e.notification -> 'readBy') = 'array'
                     then e.notification -> 'readBy' else '[]'::jsonb end)
               || (case when coalesce(
                            (case when jsonb_typeof(e.notification -> 'readBy') = 'array'
                                  then e.notification -> 'readBy' else '[]'::jsonb end) ? v_legacy_id,
                            false
                          )
                        then '[]'::jsonb
                        else jsonb_build_array(v_legacy_id)
                   end),
               true
             )
             else e.notification
           end
           order by e.ordinality
         )
    into v_next
    from jsonb_array_elements(v_notifications) with ordinality as e(notification, ordinality);
  if v_next is null then
    v_next := v_notifications;
  end if;

  update public.shared
     set data = jsonb_set(data, '{value}', to_jsonb(v_next::text), true),
         version = version + 1,
         updated_at = now()
   where id = 'notifications'
     and version = v_version;
  get diagnostics v_affected = row_count;
  return v_affected = 1;
end;
$$;

revoke all on function public.student_notifications_seen_cas(uuid, bigint, text[]) from public, anon, authenticated;
grant execute on function public.student_notifications_seen_cas(uuid, bigint, text[]) to service_role;

commit;
