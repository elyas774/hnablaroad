-- Atomic self-only attendance marking and award, computed on the server.
-- The browser cannot execute this function; Netlify calls it after verifying Supabase Auth.
begin;

alter table public.shared enable row level security;
alter table public.app_users enable row level security;
revoke all on table public.shared, public.app_users from public, anon, authenticated;

create or replace function public.student_attendance_mark_cas(
  p_auth_user_id uuid,
  p_expected bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_legacy_id text;
  v_version bigint;
  v_raw text;
  v_users jsonb;
  v_vacation jsonb := 'null'::jsonb;
  v_leave_requests jsonb := '[]'::jsonb;
  v_leave jsonb;
  v_rules jsonb;
  v_blocked boolean := false;
  v_today date;
  v_yesterday date;
  v_today_text text;
  v_user jsonb;
  v_user_next jsonb;
  v_next jsonb;
  v_attendance jsonb;
  v_dates jsonb;
  v_points numeric;
  v_total_points numeric;
  v_streak integer;
  v_matches integer;
  v_affected integer;
  v_new_version bigint;
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

  v_today := (now() at time zone 'Asia/Riyadh')::date;
  v_yesterday := v_today - 1;
  v_today_text := to_char(v_today, 'YYYY-MM-DD');

  -- Create stable sentinel rows if either setting is absent so concurrent first-time
  -- inserts cannot race the attendance decision. Keep both rows locked until commit.
  insert into public.shared (id, data, version)
  values ('vacations', '{"value":"null"}'::jsonb, 1),
         ('leaveRequests', '{"value":"[]"}'::jsonb, 1)
  on conflict (id) do nothing;

  select s.data ->> 'value' into v_raw
    from public.shared s where s.id = 'vacations' for share;
  v_vacation := coalesce(nullif(v_raw, '')::jsonb, 'null'::jsonb);
  if jsonb_typeof(v_vacation) = 'object'
     and coalesce(v_vacation ->> 'status', '') not in ('cancelled', 'rejected')
     and nullif(v_vacation ->> 'start', '') is not null
     and nullif(v_vacation ->> 'end', '') is not null
     and left(v_vacation ->> 'start', 10)::date <= v_today
     and left(v_vacation ->> 'end', 10)::date >= v_today then
    v_rules := v_vacation -> 'rules';
    if jsonb_typeof(v_rules) = 'object' then
      v_blocked := coalesce((v_rules ->> 'attendance')::boolean, false);
    else
      v_blocked := coalesce(v_vacation ->> 'mode', 'full') in ('full', 'emergency', 'light');
    end if;
  end if;

  select s.data ->> 'value' into v_raw
    from public.shared s where s.id = 'leaveRequests' for share;
  v_leave_requests := coalesce(nullif(v_raw, '')::jsonb, '[]'::jsonb);
  if not v_blocked and jsonb_typeof(v_leave_requests) = 'array' then
    for v_leave in select value from jsonb_array_elements(v_leave_requests) as x(value)
    loop
      if v_leave ->> 'status' = 'approved'
         and v_leave ->> 'userId' = v_legacy_id
         and nullif(v_leave ->> 'start', '') is not null
         and nullif(v_leave ->> 'end', '') is not null
         and left(v_leave ->> 'start', 10)::date <= v_today
         and left(v_leave ->> 'end', 10)::date >= v_today then
        v_rules := v_leave -> 'rules';
        if jsonb_typeof(v_rules) = 'object' then
          v_blocked := coalesce((v_rules ->> 'attendance')::boolean, false);
        else
          v_blocked := coalesce(v_leave ->> 'mode', 'full') in ('full', 'emergency', 'light');
        end if;
        if v_blocked then exit; end if;
      end if;
    end loop;
  end if;
  if v_blocked then
    return jsonb_build_object('ok', false, 'reason', 'attendance_paused');
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
    return jsonb_build_object('ok', false, 'conflict', true);
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

  select e.user_row into v_user
    from jsonb_array_elements(v_users) with ordinality as e(user_row, ordinality)
   where e.user_row ->> 'id' = v_legacy_id;
  v_attendance := v_user -> 'attendance';
  if jsonb_typeof(v_attendance) <> 'object' then v_attendance := '{}'::jsonb; end if;

  if v_attendance ->> 'lastDate' = v_today_text then
    return jsonb_build_object(
      'ok', true,
      'alreadyRecorded', true,
      'attendance', v_attendance,
      'points', coalesce(nullif(v_user ->> 'points', '')::numeric, 0),
      'totalPoints', coalesce(nullif(v_user ->> 'totalPoints', '')::numeric, 0),
      'version', v_version
    );
  end if;

  if nullif(v_attendance ->> 'lastDate', '')::date = v_yesterday then
    v_streak := greatest(coalesce(nullif(v_attendance ->> 'streak', '')::integer, 0), 0) + 1;
  else
    v_streak := 1;
  end if;
  v_dates := case when jsonb_typeof(v_attendance -> 'dates') = 'array'
                  then v_attendance -> 'dates' else '[]'::jsonb end;
  if not (v_dates ? v_today_text) then
    v_dates := v_dates || jsonb_build_array(v_today_text);
  end if;
  if jsonb_array_length(v_dates) > 60 then
    select coalesce(jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
      into v_dates
      from jsonb_array_elements(v_dates) with ordinality as entry(value, ordinality)
     where entry.ordinality > jsonb_array_length(v_dates) - 60;
  end if;

  v_points := coalesce(nullif(v_user ->> 'points', '')::numeric, 0) + 3;
  v_total_points := coalesce(nullif(v_user ->> 'totalPoints', '')::numeric, 0) + 3;
  v_attendance := jsonb_build_object('dates', v_dates, 'streak', v_streak, 'lastDate', v_today_text);
  v_user_next := v_user || jsonb_build_object(
    'attendance', v_attendance,
    'points', v_points,
    'totalPoints', v_total_points
  );

  select jsonb_agg(
           case when entry.user_row ->> 'id' = v_legacy_id then v_user_next else entry.user_row end
           order by entry.ordinality
         )
    into v_next
    from jsonb_array_elements(v_users) with ordinality as entry(user_row, ordinality);

  update public.shared
     set data = jsonb_set(data, '{value}', to_jsonb(v_next::text), true),
         version = version + 1,
         updated_at = now()
   where id = 'users'
     and version = v_version
  returning version into v_new_version;
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    return jsonb_build_object('ok', false, 'conflict', true);
  end if;

  return jsonb_build_object(
    'ok', true,
    'alreadyRecorded', false,
    'attendance', v_attendance,
    'points', v_points,
    'totalPoints', v_total_points,
    'version', v_new_version
  );
end;
$$;

revoke all on function public.student_attendance_mark_cas(uuid, bigint) from public, anon, authenticated;
grant execute on function public.student_attendance_mark_cas(uuid, bigint) to service_role;

commit;
