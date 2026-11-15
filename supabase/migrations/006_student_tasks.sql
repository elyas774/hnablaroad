-- Atomic task completion/proof workflow. The only entry point is a narrowly scoped
-- service-role RPC called after Netlify validates Supabase Auth.
begin;

create table if not exists public.student_task_submissions (
  submission_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  task_id text not null,
  task_group text not null check (task_group in ('daily', 'meeting', 'weekly')),
  cycle_key text not null,
  task_title text not null check (length(task_title) between 1 and 240),
  points_awarded integer not null check (points_awarded between 0 and 10000),
  status text not null check (status in ('pending', 'approved', 'rejected', 'undone')),
  proof_path text,
  proof_mime text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz not null default now(),
  constraint student_task_proof_pair check (
    (proof_path is null and proof_mime is null) or
    (proof_path is not null and proof_mime in ('image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'))
  )
);

create unique index if not exists student_task_one_active_completion
  on public.student_task_submissions(owner_legacy_id, task_id, cycle_key)
  where status in ('pending', 'approved');
create index if not exists student_task_owner_recent
  on public.student_task_submissions(owner_legacy_id, submitted_at desc);
create index if not exists student_task_pending_recent
  on public.student_task_submissions(status, submitted_at asc) where status = 'pending';

alter table public.student_task_submissions enable row level security;
revoke all on table public.student_task_submissions from public, anon, authenticated, service_role;

-- Keep this bucket private even if a broader permissive Storage policy exists elsewhere.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-proofs', 'task-proofs', false, 3670016,
        array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists student_task_proofs_deny_select on storage.objects;
drop policy if exists student_task_proofs_deny_insert on storage.objects;
drop policy if exists student_task_proofs_deny_update on storage.objects;
drop policy if exists student_task_proofs_deny_delete on storage.objects;
create policy student_task_proofs_deny_select on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'task-proofs');
create policy student_task_proofs_deny_insert on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'task-proofs');
create policy student_task_proofs_deny_update on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'task-proofs') with check (bucket_id <> 'task-proofs');
create policy student_task_proofs_deny_delete on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'task-proofs');

create or replace function public.student_tasks_action(
  p_auth_user_id uuid,
  p_op text,
  p_task_id text,
  p_cycle_key text,
  p_proof_path text,
  p_proof_mime text,
  p_approved boolean,
  p_target_user_id text,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text;
  v_leader_raw text;
  v_leader text;
  v_is_leader boolean := false;
  v_users_version bigint;
  v_users_raw text;
  v_users jsonb;
  v_user jsonb;
  v_user_next jsonb;
  v_next_users jsonb;
  v_completed jsonb;
  v_item jsonb;
  v_entry jsonb;
  v_entries jsonb;
  v_task_doc jsonb;
  v_task_value text;
  v_tasks jsonb;
  v_task jsonb;
  v_task_count integer := 0;
  v_group text;
  v_title text;
  v_points integer;
  v_matches integer;
  v_found boolean := false;
  v_award numeric;
  v_total numeric;
  v_week_points numeric;
  v_local timestamp without time zone;
  v_boundary timestamp without time zone;
  v_candidate timestamp without time zone;
  v_meeting_next timestamp without time zone;
  v_day integer;
  v_offset integer;
  v_hour integer;
  v_minute integer;
  v_expected_cycle text;
  v_iso text;
  v_status text;
  v_owner text;
  v_path text;
  v_mime text;
  v_result jsonb;
  v_items jsonb;
  v_name text;
  v_date text;
  v_new_version bigint;
  v_affected integer;
begin
  if p_auth_user_id is null or p_op not in ('submit','undo','review','mine','review_queue','proof_url') then
    raise exception 'Invalid task operation';
  end if;
  select u.legacy_id into v_actor
    from public.app_users u
   where u.auth_user_id = p_auth_user_id
     and u.needs_password_reset = false;
  if v_actor is null then raise exception 'Authenticated account is not linked or password reset is pending'; end if;

  -- A shared lock makes leadership checks linearizable against leader changes.
  select s.data ->> 'value' into v_leader_raw
    from public.shared s where s.id = 'weekLeaderId' for share;
  if v_leader_raw is not null then
    begin
      v_leader := v_leader_raw::jsonb #>> '{}';
    exception when others then
      v_leader := v_leader_raw;
    end;
  end if;
  v_is_leader := coalesce(v_leader = v_actor, false);
  if p_op in ('review','review_queue') and not v_is_leader then
    return jsonb_build_object('ok', false, 'forbidden', true);
  end if;

  if p_op = 'proof_url' then
    if p_submission_id is null then raise exception 'Submission identifier is required'; end if;
    select s.owner_legacy_id, s.proof_path, s.proof_mime, s.status
      into v_owner, v_path, v_mime, v_status
      from public.student_task_submissions s
     where s.submission_id = p_submission_id;
    if not found or v_path is null or (v_owner <> v_actor and not v_is_leader) then
      return jsonb_build_object('ok', false);
    end if;
    return jsonb_build_object('ok', true, 'proof_path', v_path, 'proof_type', case when v_mime like 'video/%' then 'video' else 'image' end, 'status', v_status);
  end if;

  if p_op = 'mine' then
    select coalesce(jsonb_agg(q.item order by q.submitted_at desc), '[]'::jsonb)
      into v_items
      from (
        select s.submitted_at, jsonb_build_object(
                 'submissionId', s.submission_id, 'studentId', s.owner_legacy_id,
                 'taskId', s.task_id, 'group', s.task_group, 'cycleKey', s.cycle_key,
                 'title', s.task_title, 'points', s.points_awarded, 'status', s.status,
                 'date', s.submitted_at, 'proof_path', s.proof_path,
                 'proofType', case when s.proof_mime like 'video/%' then 'video' when s.proof_mime is not null then 'image' else null end
               ) as item
          from public.student_task_submissions s
         where s.owner_legacy_id = v_actor
         order by s.submitted_at desc
         limit 100
      ) q;
    return jsonb_build_object('ok', true, 'items', v_items);
  end if;

  if p_op = 'review_queue' then
    select s.version, s.data ->> 'value' into v_users_version, v_users_raw
      from public.shared s where s.id = 'users' for share;
    if v_users_raw is not null then
      begin v_users := v_users_raw::jsonb; exception when others then v_users := '[]'::jsonb; end;
    else v_users := '[]'::jsonb; end if;
    select coalesce(jsonb_agg(q.item order by q.submitted_at asc), '[]'::jsonb)
      into v_items
      from (
        select s.submitted_at, jsonb_build_object(
                 'submissionId', s.submission_id, 'studentId', s.owner_legacy_id,
                 'studentName', coalesce(u.user_row ->> 'name', u.user_row ->> 'username', s.owner_legacy_id),
                 'taskId', s.task_id, 'group', s.task_group, 'cycleKey', s.cycle_key,
                 'title', s.task_title, 'points', s.points_awarded, 'status', s.status,
                 'date', s.submitted_at, 'proof_path', s.proof_path,
                 'proofType', case when s.proof_mime like 'video/%' then 'video' else 'image' end
               ) as item
          from public.student_task_submissions s
          left join lateral (
            select e.user_row from jsonb_array_elements(
              case when jsonb_typeof(v_users) = 'array' then v_users else '[]'::jsonb end
            ) as e(user_row) where e.user_row ->> 'id' = s.owner_legacy_id limit 1
          ) u on true
         where s.status = 'pending'
         order by s.submitted_at asc
         limit 100
      ) q;
    return jsonb_build_object('ok', true, 'items', coalesce(v_items, '[]'::jsonb));
  end if;

  if p_op not in ('submit','undo','review') then raise exception 'Invalid task operation'; end if;
  if p_task_id is null or length(p_task_id) < 1 or length(p_task_id) > 100 or p_task_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Invalid task identifier';
  end if;
  if p_cycle_key is null or length(p_cycle_key) > 80 then raise exception 'Invalid task cycle'; end if;
  if p_op = 'review' then
    if p_target_user_id is null or length(p_target_user_id) < 1 or length(p_target_user_id) > 160 or p_approved is null then
      raise exception 'Invalid task review';
    end if;
  elsif p_op = 'submit' then
    if p_submission_id is null or p_proof_path is null or p_proof_mime is null then raise exception 'Proof is required'; end if;
    if p_proof_mime not in ('image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime') then raise exception 'Unsupported proof type'; end if;
    if p_proof_path !~ ('^' || p_auth_user_id::text || '/' || p_submission_id::text || '\.(jpg|png|webp|gif|mp4|webm|mov)$') then
      raise exception 'Invalid private proof path';
    end if;
    if (p_proof_mime = 'image/jpeg' and right(p_proof_path,4) <> '.jpg') or
       (p_proof_mime = 'image/png' and right(p_proof_path,4) <> '.png') or
       (p_proof_mime = 'image/webp' and right(p_proof_path,5) <> '.webp') or
       (p_proof_mime = 'image/gif' and right(p_proof_path,4) <> '.gif') or
       (p_proof_mime = 'video/mp4' and right(p_proof_path,4) <> '.mp4') or
       (p_proof_mime = 'video/webm' and right(p_proof_path,5) <> '.webm') or
       (p_proof_mime = 'video/quicktime' and right(p_proof_path,4) <> '.mov') then
      raise exception 'Proof MIME and path do not match';
    end if;
  end if;

  -- The task list row is held stable while the server derives authoritative title/points.
  select s.data into v_task_doc from public.shared s where s.id = 'customTasks' for share;
  if v_task_doc is not null then
    v_task_value := v_task_doc ->> 'value';
    begin v_tasks := v_task_value::jsonb; exception when others then v_tasks := '{}'::jsonb; end;
  else v_tasks := '{}'::jsonb; end if;
  v_group := split_part(p_cycle_key, '-', 1);
  if v_group not in ('daily','meeting','weekly') then raise exception 'Invalid task group'; end if;
  if v_group = 'weekly' and jsonb_typeof(v_tasks -> 'weekly') = 'array' and jsonb_array_length(v_tasks -> 'weekly') = 0 then
    v_tasks := jsonb_set(v_tasks, '{weekly}', jsonb_build_array(
      jsonb_build_object('id','side-1','group','weekly','title','حفظ آية من الآيات الموجودة في المتن','points',5),
      jsonb_build_object('id','side-2','group','weekly','title','حفظ حديث من الأحاديث الموجودة في المتن','points',10),
      jsonb_build_object('id','side-3','group','weekly','title','تلخيص المتن في دفتر','points',20),
      jsonb_build_object('id','side-4','group','weekly','title','البحث عن مجال علمي تم أخذه في المتن','points',30)
    ), true);
  elsif v_group = 'weekly' and coalesce(jsonb_typeof(v_tasks -> 'weekly'),'null') <> 'array' then
    v_tasks := jsonb_set(v_tasks, '{weekly}', jsonb_build_array(
      jsonb_build_object('id','side-1','group','weekly','title','حفظ آية من الآيات الموجودة في المتن','points',5),
      jsonb_build_object('id','side-2','group','weekly','title','حفظ حديث من الأحاديث الموجودة في المتن','points',10),
      jsonb_build_object('id','side-3','group','weekly','title','تلخيص المتن في دفتر','points',20),
      jsonb_build_object('id','side-4','group','weekly','title','البحث عن مجال علمي تم أخذه في المتن','points',30)
    ), true);
  end if;
  if coalesce(jsonb_typeof(v_tasks -> v_group),'null') = 'array' then
    select count(*), min(e.task_row::text)::jsonb into v_task_count, v_task
      from jsonb_array_elements(v_tasks -> v_group) as e(task_row)
     where e.task_row ->> 'id' = p_task_id;
  else
    v_task_count := 0;
  end if;
  if v_task_count <> 1 or v_task is null then raise exception 'Task does not exist'; end if;
  v_title := btrim(coalesce(v_task ->> 'title',''));
  if length(v_title) < 1 or length(v_title) > 240 then raise exception 'Invalid task title'; end if;
  begin
    v_points := (v_task ->> 'points')::numeric::integer;
  exception when others then raise exception 'Invalid task points';
  end;
  if v_points < 0 or v_points > 10000 or (v_task ->> 'points')::numeric <> v_points then raise exception 'Invalid task points'; end if;

  if p_op = 'submit' then
    v_local := now() at time zone 'Asia/Riyadh';
    if v_group = 'daily' then
      -- Both client and server use the course calendar date, explicitly in Riyadh.
      v_expected_cycle := 'daily-' || to_char(v_local::date, 'YYYY-MM-DD');
    elsif v_group = 'weekly' then
      v_day := extract(dow from v_local)::integer;
      v_boundary := date_trunc('day',v_local) - ((v_day - 6 + 7) % 7) * interval '1 day' + interval '13 hours 30 minutes';
      if v_boundary > v_local then v_boundary := v_boundary - interval '7 days'; end if;
      v_iso := to_char((v_boundary at time zone 'Asia/Riyadh') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      v_expected_cycle := 'weekly-' || v_iso;
    else
      v_meeting_next := null;
      for v_offset, v_hour, v_minute in select * from (values (0,13,30),(2,13,30),(5,17,30)) as m(day_offset,hour_value,minute_value)
      loop
        v_candidate := date_trunc('day',v_local) + v_offset * interval '1 day' + v_hour * interval '1 hour' + v_minute * interval '1 minute';
        if v_candidate <= v_local then v_candidate := v_candidate + interval '7 days'; end if;
        if v_meeting_next is null or v_candidate < v_meeting_next then v_meeting_next := v_candidate; end if;
      end loop;
      v_iso := to_char((v_meeting_next at time zone 'Asia/Riyadh') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      v_expected_cycle := 'meeting-' || v_iso;
    end if;
    if p_cycle_key <> v_expected_cycle then return jsonb_build_object('ok', false, 'conflict', true); end if;
  end if;

  -- Lock the canonical shared user list. This serializes points and completion changes.
  select s.version, s.data ->> 'value' into v_users_version, v_users_raw
    from public.shared s where s.id = 'users' for update;
  if not found or v_users_raw is null then raise exception 'User state is unavailable'; end if;
  begin v_users := v_users_raw::jsonb; exception when others then raise exception 'User state is malformed'; end;
  if jsonb_typeof(v_users) <> 'array' then raise exception 'User state is malformed'; end if;
  select count(*) into v_matches from jsonb_array_elements(v_users) as e(user_row) where e.user_row ->> 'id' = case when p_op = 'review' then p_target_user_id else v_actor end;
  if v_matches <> 1 then return jsonb_build_object('ok', false, 'conflict', true); end if;
  select e.user_row into v_user from jsonb_array_elements(v_users) as e(user_row)
   where e.user_row ->> 'id' = case when p_op = 'review' then p_target_user_id else v_actor end limit 1;

  if p_op = 'submit' then
    if exists (select 1 from public.student_task_submissions s where s.owner_legacy_id = v_actor and s.task_id = p_task_id and s.cycle_key = p_cycle_key and s.status in ('pending','approved')) then
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    v_completed := case when jsonb_typeof(v_user -> 'completedTasks') = 'array' then v_user -> 'completedTasks' else '[]'::jsonb end;
    for v_item in select value from jsonb_array_elements(v_completed)
    loop
      if (jsonb_typeof(v_item) = 'string' and v_item #>> '{}' = p_task_id) or
         (jsonb_typeof(v_item) = 'object' and v_item ->> 'id' = p_task_id and coalesce(v_item ->> 'cycleKey',p_cycle_key) = p_cycle_key) then
        return jsonb_build_object('ok', true, 'duplicate', true);
      end if;
    end loop;
    v_date := to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_entry := jsonb_build_object(
      'id',p_task_id,'cycleKey',p_cycle_key,'submissionId',p_submission_id,
      'proofType',case when p_proof_mime like 'video/%' then 'video' else 'image' end,
      'proofKey','taskproof-' || left(regexp_replace(v_actor,'[^A-Za-z0-9_-]','_','g'),50) || '-' || left(regexp_replace(p_task_id,'[^A-Za-z0-9_-]','_','g'),50) || '-' || left(regexp_replace(p_cycle_key,'[^A-Za-z0-9_-]','_','g'),50),
      'date',v_date
    );
    v_completed := v_completed || jsonb_build_array(v_entry);
    begin v_week_points := coalesce(nullif(v_user ->> 'points','')::numeric,0); exception when others then v_week_points := 0; end;
    begin v_total := coalesce(nullif(v_user ->> 'totalPoints','')::numeric,0); exception when others then v_total := 0; end;
    v_user_next := v_user || jsonb_build_object('completedTasks',v_completed,'points',v_week_points + v_points,'totalPoints',v_total + v_points);
    if position('حفظ' in v_title) > 0 then
      v_entries := case when jsonb_typeof(v_user -> 'memorizationLog') = 'array' then v_user -> 'memorizationLog' else '[]'::jsonb end;
      v_entries := jsonb_build_array(jsonb_build_object('text',v_title,'date',v_date)) || v_entries;
      if jsonb_array_length(v_entries) > 200 then v_entries := (select jsonb_agg(x.value order by x.ordinality) from jsonb_array_elements(v_entries) with ordinality x(value,ordinality) where x.ordinality <= 200); end if;
      v_user_next := v_user_next || jsonb_build_object('memorizationLog',v_entries);
    end if;
    select jsonb_agg(case when e.user_row ->> 'id' = v_actor then v_user_next else e.user_row end order by e.ordinality)
      into v_next_users from jsonb_array_elements(v_users) with ordinality e(user_row,ordinality);
    insert into public.student_task_submissions(submission_id,owner_legacy_id,owner_auth_user_id,task_id,task_group,cycle_key,task_title,points_awarded,status,proof_path,proof_mime)
    values (p_submission_id,v_actor,p_auth_user_id,p_task_id,v_group,p_cycle_key,v_title,v_points,'pending',p_proof_path,p_proof_mime);
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_next_users::text),true),version=version+1,updated_at=now()
      where id='users' and version=v_users_version returning version into v_new_version;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then raise exception 'Concurrent task update'; end if;
    return jsonb_build_object('ok',true,'status','pending','points',v_points,'title',v_title,'date',v_date,'version',v_new_version);
  end if;

  if p_op = 'undo' then
    select s.submission_id,s.points_awarded,s.task_title,s.status,s.proof_path into p_submission_id,v_points,v_title,v_status,v_path
      from public.student_task_submissions s
     where s.owner_legacy_id=v_actor and s.task_id=p_task_id and s.cycle_key=p_cycle_key and s.status in ('pending','approved')
     for update;
    if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
    v_completed := case when jsonb_typeof(v_user -> 'completedTasks')='array' then v_user -> 'completedTasks' else '[]'::jsonb end;
    select coalesce(jsonb_agg(x.value order by x.ordinality) filter (where not (
             (jsonb_typeof(x.value)='object' and x.value ->> 'id'=p_task_id and x.value ->> 'cycleKey'=p_cycle_key)
             or (jsonb_typeof(x.value)='string' and x.value #>> '{}'=p_task_id)
           )), '[]'::jsonb),
           bool_or((jsonb_typeof(x.value)='object' and x.value ->> 'id'=p_task_id and x.value ->> 'cycleKey'=p_cycle_key)
             or (jsonb_typeof(x.value)='string' and x.value #>> '{}'=p_task_id))
      into v_entries,v_found from jsonb_array_elements(v_completed) with ordinality x(value,ordinality);
    if not coalesce(v_found,false) then return jsonb_build_object('ok',false,'conflict',true); end if;
    begin v_week_points := coalesce(nullif(v_user ->> 'points','')::numeric,0); exception when others then v_week_points := 0; end;
    begin v_total := coalesce(nullif(v_user ->> 'totalPoints','')::numeric,0); exception when others then v_total := 0; end;
    v_user_next := v_user || jsonb_build_object('completedTasks',v_entries,'points',v_week_points-v_points,'totalPoints',greatest(0,v_total-v_points));
    select jsonb_agg(case when e.user_row ->> 'id'=v_actor then v_user_next else e.user_row end order by e.ordinality)
      into v_next_users from jsonb_array_elements(v_users) with ordinality e(user_row,ordinality);
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_next_users::text),true),version=version+1,updated_at=now()
      where id='users' and version=v_users_version returning version into v_new_version;
    get diagnostics v_affected=row_count;
    if v_affected<>1 then raise exception 'Concurrent task update'; end if;
    update public.student_task_submissions set status='undone',proof_path=null,proof_mime=null,reviewed_at=now(),reviewed_by=v_actor
      where submission_id=p_submission_id;
    return jsonb_build_object('ok',true,'status','undone','points',v_points,'title',v_title,'delete_path',v_path,'version',v_new_version);
  end if;

  -- Only the current leader may reach here. Both leader identity and user data remain locked.
  if not v_is_leader then return jsonb_build_object('ok',false,'forbidden',true); end if;
  select s.submission_id,s.points_awarded,s.task_title,s.status,s.proof_path,s.owner_legacy_id
    into p_submission_id,v_points,v_title,v_status,v_path,v_owner
    from public.student_task_submissions s
   where s.owner_legacy_id=p_target_user_id and s.task_id=p_task_id and s.cycle_key=p_cycle_key and s.status='pending'
   for update;
  if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
  v_completed := case when jsonb_typeof(v_user -> 'completedTasks')='array' then v_user -> 'completedTasks' else '[]'::jsonb end;
  v_found := false;
  v_entries := '[]'::jsonb;
  for v_item in select value from jsonb_array_elements(v_completed)
  loop
    if jsonb_typeof(v_item)='object' and v_item ->> 'id'=p_task_id and v_item ->> 'cycleKey'=p_cycle_key then
      v_found := true;
      if p_approved then v_entries := v_entries || jsonb_build_array(v_item || jsonb_build_object('leaderApproved',true)); end if;
    else
      v_entries := v_entries || jsonb_build_array(v_item);
    end if;
  end loop;
  if not v_found then return jsonb_build_object('ok',false,'conflict',true); end if;
  begin v_week_points := coalesce(nullif(v_user ->> 'points','')::numeric,0); exception when others then v_week_points := 0; end;
  begin v_total := coalesce(nullif(v_user ->> 'totalPoints','')::numeric,0); exception when others then v_total := 0; end;
  if p_approved then
    v_user_next := v_user || jsonb_build_object('completedTasks',v_entries);
    v_status := 'approved';
  else
    v_user_next := v_user || jsonb_build_object('completedTasks',v_entries,'points',v_week_points-v_points,'totalPoints',greatest(0,v_total-v_points));
    v_status := 'rejected';
  end if;
  select jsonb_agg(case when e.user_row ->> 'id'=p_target_user_id then v_user_next else e.user_row end order by e.ordinality)
    into v_next_users from jsonb_array_elements(v_users) with ordinality e(user_row,ordinality);
  update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_next_users::text),true),version=version+1,updated_at=now()
    where id='users' and version=v_users_version returning version into v_new_version;
  get diagnostics v_affected=row_count;
  if v_affected<>1 then raise exception 'Concurrent task update'; end if;
  update public.student_task_submissions set status=v_status,reviewed_at=now(),reviewed_by=v_actor,
    proof_path=case when p_approved then proof_path else null end,
    proof_mime=case when p_approved then proof_mime else null end
   where submission_id=p_submission_id;
  return jsonb_build_object('ok',true,'status',v_status,'points',v_points,'title',v_title,'approved',p_approved,
    'delete_path',case when p_approved then null else v_path end,'version',v_new_version);
end;
$$;

revoke all on function public.student_tasks_action(uuid,text,text,text,text,text,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.student_tasks_action(uuid,text,text,text,text,text,boolean,text,uuid) to service_role;

commit;
