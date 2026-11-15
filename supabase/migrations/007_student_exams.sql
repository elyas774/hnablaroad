-- Private exam workflow. Existing shared exam definitions remain the source of truth;
-- every mutation and every attempt transition is a purpose-specific transaction.
begin;

create table if not exists public.student_exam_attempts (
  attempt_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  exam_kind text not null check (exam_kind in ('question_bank','published')),
  exam_id text not null,
  answers jsonb not null check (jsonb_typeof(answers) = 'array' and jsonb_array_length(answers) between 1 and 500),
  score integer not null default 0 check (score between 0 and 500),
  points_awarded integer not null default 0 check (points_awarded between 0 and 5000),
  status text not null check (status in ('submitted','redone')),
  attachment_path text,
  attachment_mime text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  constraint student_exam_attachment_pair check (
    (attachment_path is null and attachment_mime is null) or
    (attachment_path is not null and attachment_mime in ('image/jpeg','image/png','image/webp','application/pdf'))
  )
);
create unique index if not exists student_exam_one_active_attempt
  on public.student_exam_attempts(owner_legacy_id, exam_kind, exam_id) where status = 'submitted';
create index if not exists student_exam_owner_recent
  on public.student_exam_attempts(owner_legacy_id, submitted_at desc);
create index if not exists student_exam_pending_recent
  on public.student_exam_attempts(exam_kind, exam_id, submitted_at asc) where status = 'submitted';
alter table public.student_exam_attempts enable row level security;
revoke all on table public.student_exam_attempts from public, anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exam-attachments','exam-attachments',false,2097152,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set name=excluded.name, public=false,
  file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists student_exam_attachments_deny_select on storage.objects;
drop policy if exists student_exam_attachments_deny_insert on storage.objects;
drop policy if exists student_exam_attachments_deny_update on storage.objects;
drop policy if exists student_exam_attachments_deny_delete on storage.objects;
create policy student_exam_attachments_deny_select on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'exam-attachments');
create policy student_exam_attachments_deny_insert on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'exam-attachments');
create policy student_exam_attachments_deny_update on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'exam-attachments') with check (bucket_id <> 'exam-attachments');
create policy student_exam_attachments_deny_delete on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'exam-attachments');

-- Same tolerant Arabic normalization and <=2 edit-distance allowance as the legacy UI,
-- implemented with a small rolling band so bounded inputs do not allocate an NxN matrix.
create or replace function public.student_exam_answer_matches(p_given text, p_expected text)
returns boolean
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare
  a text;
  b text;
  n integer;
  m integer;
  i integer;
  j integer;
  lo integer;
  hi integer;
  inf integer := 1000000;
  prev integer[];
  curr integer[];
  cost integer;
begin
  a := lower(regexp_replace(translate(regexp_replace(coalesce(p_given,''), '[ًٌٍَُِّْٰـ]', '', 'g'), 'إأآاىةؤئ', 'اااايهيي'), '\s+', ' ', 'g'));
  b := lower(regexp_replace(translate(regexp_replace(coalesce(p_expected,''), '[ًٌٍَُِّْٰـ]', '', 'g'), 'إأآاىةؤئ', 'اااايهيي'), '\s+', ' ', 'g'));
  a := btrim(a); b := btrim(b);
  n := char_length(a); m := char_length(b);
  if n = 0 or m = 0 then return n = m; end if;
  if abs(n-m) > 2 then return false; end if;
  prev := array_fill(inf, ARRAY[m+1]);
  for j in 0..least(m,2) loop prev[j+1] := j; end loop;
  for i in 1..n loop
    curr := array_fill(inf, ARRAY[m+1]);
    if i <= 2 then curr[1] := i; end if;
    lo := greatest(1,i-2); hi := least(m,i+2);
    for j in lo..hi loop
      cost := case when substr(a,i,1)=substr(b,j,1) then 0 else 1 end;
      curr[j+1] := least(prev[j+1]+1, curr[j]+1, prev[j]+cost);
    end loop;
    prev := curr;
  end loop;
  return prev[m+1] <= 2;
end;
$$;
revoke all on function public.student_exam_answer_matches(text,text) from public, anon, authenticated;

create or replace function public.student_exams_action(
  p_auth_user_id uuid,
  p_op text,
  p_kind text,
  p_exam_id text,
  p_target_user_id text,
  p_qid text,
  p_answers jsonb,
  p_points integer,
  p_question text,
  p_answer text,
  p_exam jsonb,
  p_attempt_id uuid,
  p_attachment_path text,
  p_attachment_mime text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text;
  v_actor_name text;
  v_leader_raw text;
  v_leader text;
  v_is_leader boolean := false;
  v_kind text;
  v_exam_id text;
  v_doc jsonb;
  v_version bigint;
  v_raw text;
  v_exam_set jsonb;
  v_exam jsonb;
  v_questions jsonb;
  v_question jsonb;
  v_given jsonb;
  v_answers jsonb;
  v_result_answers jsonb;
  v_answer jsonb;
  v_qid text;
  v_correct boolean;
  v_score integer := 0;
  v_points integer := 0;
  v_old_points integer := 0;
  v_delta integer := 0;
  v_attempt public.student_exam_attempts%rowtype;
  v_target public.student_exam_attempts%rowtype;
  v_items jsonb;
  v_item jsonb;
  v_users jsonb;
  v_user jsonb;
  v_user_next jsonb;
  v_next_users jsonb;
  v_users_raw text;
  v_users_version bigint;
  v_matches integer;
  v_new_version bigint;
  v_updated integer;
  v_next_exam jsonb;
  v_archive jsonb;
  v_archive_raw text;
  v_archive_version bigint;
  v_i integer;
  v_total integer;
  v_seen integer := 0;
  v_found boolean := false;
  v_attachment_ext text;
begin
  if p_auth_user_id is null or p_op not in ('mine','review_queue','submit','redo','grade','question_add','question_delete','publish','published_delete','attachment_url') then
    raise exception 'Invalid exam operation';
  end if;
  select u.legacy_id, coalesce(nullif(u.display_name,''),u.username)
    into v_actor, v_actor_name
    from public.app_users u
   where u.auth_user_id=p_auth_user_id and u.needs_password_reset=false;
  if v_actor is null then raise exception 'Account not linked or password reset required'; end if;
  select s.data->>'value' into v_leader_raw from public.shared s where s.id='weekLeaderId' for share;
  if v_leader_raw is not null then
    begin v_leader := v_leader_raw::jsonb #>> '{}'; exception when others then v_leader := v_leader_raw; end;
  end if;
  v_is_leader := coalesce(v_leader=v_actor,false);
  if p_op in ('question_add','question_delete','publish','published_delete','review_queue','grade') and not v_is_leader then
    return jsonb_build_object('ok',false,'forbidden',true);
  end if;

  if p_op='mine' then
    select coalesce(jsonb_agg(x.item order by x.submitted_at desc),'[]'::jsonb) into v_items
      from (select s.submitted_at,jsonb_build_object(
        'attemptId',s.attempt_id,'kind',s.exam_kind,'examId',s.exam_id,'answers',s.answers,
        'score',s.score,'points',s.points_awarded,'date',s.submitted_at,'status',s.status,
        'attachment_path',s.attachment_path
      ) item from public.student_exam_attempts s where s.owner_legacy_id=v_actor order by s.submitted_at desc limit 100) x;
    return jsonb_build_object('ok',true,'items',v_items);
  end if;
  if p_op='attachment_url' then
    if p_attempt_id is null then raise exception 'Invalid attempt'; end if;
    select * into v_attempt from public.student_exam_attempts s where s.attempt_id=p_attempt_id;
    if not found or v_attempt.attachment_path is null or (v_attempt.owner_legacy_id<>v_actor and not v_is_leader) then
      return jsonb_build_object('ok',false);
    end if;
    return jsonb_build_object('ok',true,'attachment_path',v_attempt.attachment_path);
  end if;
  if p_op='review_queue' then
    if p_kind not in ('question_bank','published') or p_exam_id is null then raise exception 'Invalid exam selection'; end if;
    if p_kind='question_bank' then
      v_exam_id:='question_bank';
    else
      v_exam_id:=p_exam_id;
    end if;
    if v_exam_id is null then
      return jsonb_build_object('ok',true,'items','[]'::jsonb);
    end if;
    select s.version,s.data->>'value' into v_users_version,v_users_raw from public.shared s where s.id='users' for share;
    begin v_users:=v_users_raw::jsonb; exception when others then v_users:='[]'::jsonb; end;
    select coalesce(jsonb_agg(x.item order by x.submitted_at asc),'[]'::jsonb) into v_items
      from (select a.submitted_at,jsonb_build_object(
        'attemptId',a.attempt_id,'studentId',a.owner_legacy_id,
        'studentName',coalesce((select e.user_row->>'name' from jsonb_array_elements(coalesce(v_users,'[]'::jsonb)) e(user_row) where e.user_row->>'id'=a.owner_legacy_id limit 1),a.owner_legacy_id),
        'kind',a.exam_kind,'examId',a.exam_id,'answers',a.answers,'score',a.score,'points',a.points_awarded,
        'date',a.submitted_at,'attachment_path',a.attachment_path
      ) item from public.student_exam_attempts a where a.exam_kind=p_kind and a.exam_id=v_exam_id and a.status='submitted' order by a.submitted_at asc limit 100) x;
    return jsonb_build_object('ok',true,'items',v_items);
  end if;
  if p_op='question_add' then
    if p_question is null or length(btrim(p_question)) not between 1 and 1000 or p_answer is null or length(btrim(p_answer)) not between 1 and 2000 or p_qid is null or p_qid !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'Invalid question'; end if;
    insert into public.shared(id,data,version) values('examQuestions','{"value":"[]"}'::jsonb,1) on conflict(id) do nothing;
    select s.version,s.data->>'value' into v_version,v_raw from public.shared s where s.id='examQuestions' for update;
    begin v_questions:=v_raw::jsonb; exception when others then raise exception 'Malformed question list'; end;
    if jsonb_typeof(v_questions)<>'array' or jsonb_array_length(v_questions)>=500 or exists(select 1 from jsonb_array_elements(v_questions) x where x->>'id'=p_qid) then raise exception 'Question list unavailable'; end if;
    v_questions:=v_questions||jsonb_build_array(jsonb_build_object('id',p_qid,'question',btrim(p_question),'answer',btrim(p_answer)));
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_questions::text),true),version=version+1,updated_at=now() where id='examQuestions' and version=v_version;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then return jsonb_build_object('ok',false,'conflict',true); end if;
    return jsonb_build_object('ok',true,'result',jsonb_build_object('id',p_qid));
  end if;
  if p_op='question_delete' then
    select s.version,s.data->>'value' into v_version,v_raw from public.shared s where s.id='examQuestions' for update;
    if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
    begin v_questions:=v_raw::jsonb; exception when others then raise exception 'Malformed question list'; end;
    select q into v_question from jsonb_array_elements(v_questions) q where q->>'id'=p_qid limit 1;
    if v_question is null then return jsonb_build_object('ok',false,'conflict',true); end if;
    v_questions:=coalesce((select jsonb_agg(q order by ord) from jsonb_array_elements(v_questions) with ordinality a(q,ord) where q->>'id'<>p_qid),'[]'::jsonb);
    insert into public.shared(id,data,version) values('examArchive','{"value":"[]"}'::jsonb,1) on conflict(id) do nothing;
    select s.version,s.data->>'value' into v_archive_version,v_archive_raw from public.shared s where s.id='examArchive' for update;
    begin v_archive:=v_archive_raw::jsonb; exception when others then v_archive:='[]'::jsonb; end;
    if jsonb_typeof(v_archive)<>'array' then v_archive:='[]'::jsonb; end if;
    v_archive:=jsonb_build_array(v_question||jsonb_build_object('date',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))||v_archive;
    select coalesce(jsonb_agg(z.value order by z.ordinality),'[]'::jsonb) into v_archive from jsonb_array_elements(v_archive) with ordinality z(value,ordinality) where z.ordinality<=300;
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_questions::text),true),version=version+1,updated_at=now() where id='examQuestions' and version=v_version;
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_archive::text),true),version=version+1,updated_at=now() where id='examArchive' and version=v_archive_version;
    return jsonb_build_object('ok',true);
  end if;
  if p_op='publish' then
    if p_exam is null or jsonb_typeof(p_exam)<>'object' or (select count(*) from jsonb_object_keys(p_exam))<>4 or
       not (p_exam ?& array['id','title','difficulty','questions']) or p_exam->>'id' !~ '^[A-Za-z0-9_-]{1,100}$' or
       length(btrim(coalesce(p_exam->>'title','')))<1 or length(p_exam->>'title')>160 or p_exam->>'difficulty' not in ('medium','hard') or
       jsonb_typeof(p_exam->'questions')<>'array' or jsonb_array_length(p_exam->'questions') not between 2 and 20 then raise exception 'Invalid exam definition'; end if;
    if exists(select 1 from jsonb_array_elements(p_exam->'questions') as e(q) where jsonb_typeof(q)<>'object' or q->>'id' !~ '^[A-Za-z0-9_-]{1,100}$' or q->>'type' not in ('multiple','truefalse','essay') or length(coalesce(q->>'q','')) not between 1 and 600 or (select count(*) from jsonb_object_keys(q))>12 or exists(select 1 from jsonb_object_keys(q) as k(key) where key not in ('id','q','type','options','answer','modelAnswer','explanation','instruction','passage','statement'))) then raise exception 'Invalid question definition'; end if;
    if exists(select 1 from jsonb_array_elements(p_exam->'questions') q where (q->>'type'='essay' and (not (q ? 'modelAnswer') or length(q->>'modelAnswer') not between 1 and 2000)) or (q->>'type'<>'essay' and (not (q ? 'answer') or not (q ? 'options') or jsonb_typeof(q->'options')<>'array' or jsonb_array_length(q->'options') not between 2 and 6 or not (q->'options' ? (q->>'answer'))))) then raise exception 'Invalid answer definition'; end if;
    if (select count(distinct q->>'id') from jsonb_array_elements(p_exam->'questions') q)<>jsonb_array_length(p_exam->'questions') then raise exception 'Duplicate question identifier'; end if;
    insert into public.shared(id,data,version) values('aiExams','{"value":"[]"}'::jsonb,1) on conflict(id) do nothing;
    select s.version,s.data->>'value' into v_version,v_raw from public.shared s where s.id='aiExams' for update;
    begin v_exam_set:=v_raw::jsonb; exception when others then raise exception 'Malformed exams'; end;
    if jsonb_typeof(v_exam_set)<>'array' or jsonb_array_length(v_exam_set)>=200 or exists(select 1 from jsonb_array_elements(v_exam_set) x where x->>'id'=p_exam->>'id') then return jsonb_build_object('ok',false,'conflict',true); end if;
    select coalesce(u.user_row->>'name',u.user_row->>'username',v_actor) into v_actor_name from public.shared s cross join lateral jsonb_array_elements((s.data->>'value')::jsonb) u(user_row) where s.id='users' and u.user_row->>'id'=v_actor limit 1;
    v_exam:=jsonb_build_object('id',p_exam->>'id','title',btrim(p_exam->>'title'),'difficulty',p_exam->>'difficulty','questions',p_exam->'questions','published',true,'authorId',v_actor,'authorName',coalesce(v_actor_name,v_actor),'date',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'version',4);
    v_exam_set:=jsonb_build_array(v_exam)||v_exam_set;
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_exam_set::text),true),version=version+1,updated_at=now() where id='aiExams' and version=v_version;
    return jsonb_build_object('ok',true,'result',jsonb_build_object('examId',p_exam->>'id'));
  end if;
  if p_op='published_delete' then
    select s.version,s.data->>'value' into v_version,v_raw from public.shared s where s.id='aiExams' for update;
    if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
    begin v_exam_set:=v_raw::jsonb; exception when others then raise exception 'Malformed exams'; end;
    if not exists(select 1 from jsonb_array_elements(v_exam_set) e where e->>'id'=p_exam_id and e->>'published'='true') then return jsonb_build_object('ok',false,'conflict',true); end if;
    v_exam_set:=coalesce((select jsonb_agg(e order by ord) from jsonb_array_elements(v_exam_set) with ordinality x(e,ord) where e->>'id'<>p_exam_id),'[]'::jsonb);
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_exam_set::text),true),version=version+1,updated_at=now() where id='aiExams' and version=v_version;
    return jsonb_build_object('ok',true);
  end if;

  if p_kind not in ('question_bank','published') or (p_kind='published' and (p_exam_id is null or p_exam_id !~ '^[A-Za-z0-9_-]{1,100}$')) then raise exception 'Invalid exam selection'; end if;
  v_kind:=p_kind; v_exam_id:=p_exam_id;
  if p_kind='question_bank' then
    v_exam_id:='question_bank';
    if p_op='submit' then
      select s.data into v_doc from public.shared s where s.id='examQuestions' for share;
      if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
      begin v_raw:=v_doc->>'value'; v_questions:=v_raw::jsonb; exception when others then raise exception 'Malformed questions'; end;
      if jsonb_typeof(v_questions)<>'array' or jsonb_array_length(v_questions) not between 1 and 500 then return jsonb_build_object('ok',false,'conflict',true); end if;
      if exists(select 1 from jsonb_array_elements(v_questions) q where coalesce(q->>'id','') !~ '^[A-Za-z0-9_-]{1,100}$') then raise exception 'Invalid question list'; end if;
      if (select count(distinct q->>'id') from jsonb_array_elements(v_questions) q)<>jsonb_array_length(v_questions) then raise exception 'Duplicate question identifier'; end if;
      v_exam:=jsonb_build_object('questions',v_questions);
    end if;
  else
    if p_op='submit' then
      select s.data into v_doc from public.shared s where s.id='aiExams' for share;
      begin v_exam_set:=(v_doc->>'value')::jsonb; exception when others then v_exam_set:='[]'::jsonb; end;
      select e into v_exam from jsonb_array_elements(coalesce(v_exam_set,'[]'::jsonb)) e where e->>'id'=v_exam_id and e->>'published'='true' limit 1;
      if v_exam is null or jsonb_typeof(v_exam->'questions')<>'array' or jsonb_array_length(v_exam->'questions') not between 1 and 20 then return jsonb_build_object('ok',false,'conflict',true); end if;
      v_questions:=v_exam->'questions';
    end if;
  end if;

  if p_op='submit' then
    if jsonb_typeof(p_answers)<>'array' or jsonb_array_length(p_answers)<>jsonb_array_length(v_questions) or p_attempt_id is null then raise exception 'Every exam question requires an answer'; end if;
    if exists(select 1 from jsonb_array_elements(p_answers) a group by a->>'qid' having count(*)>1) then raise exception 'Duplicate submitted answer'; end if;
    if v_kind='published' and (select count(q->>'id') from jsonb_array_elements(v_questions) q where q ? 'id')<>(select count(distinct q->>'id') from jsonb_array_elements(v_questions) q where q ? 'id') then raise exception 'Duplicate question identifier'; end if;
    if (p_attachment_path is null) <> (p_attachment_mime is null) then raise exception 'Invalid attachment'; end if;
    if p_attachment_path is not null then
      if p_attachment_mime not in ('image/jpeg','image/png','image/webp','application/pdf') or p_attachment_path !~ ('^'||p_auth_user_id::text||'/'||p_attempt_id::text||'\.(jpg|png|webp|pdf)$') then raise exception 'Invalid private attachment path'; end if;
      if (p_attachment_mime='image/jpeg' and right(p_attachment_path,4)<>'.jpg') or (p_attachment_mime='image/png' and right(p_attachment_path,4)<>'.png') or (p_attachment_mime='image/webp' and right(p_attachment_path,5)<>'.webp') or (p_attachment_mime='application/pdf' and right(p_attachment_path,4)<>'.pdf') then raise exception 'Attachment MIME and path do not match'; end if;
    end if;
    select * into v_attempt from public.student_exam_attempts a where a.owner_legacy_id=v_actor and a.exam_kind=v_kind and a.exam_id=v_exam_id and a.status='submitted' for update;
    if found then return jsonb_build_object('ok',true,'duplicate',true); end if;
    v_result_answers:='[]'::jsonb;
    for v_question in select value from jsonb_array_elements(v_questions)
    loop
      v_qid:=coalesce(v_question->>'id',case when v_kind='published' then 'legacy-'||v_exam_id||'-'||v_seen::text else null end);
      if v_kind='question_bank' then v_qid:=v_question->>'id'; end if;
      select x into v_given from jsonb_array_elements(p_answers) x where x->>'qid'=v_qid limit 1;
      if v_given is null or jsonb_typeof(v_given)<>'object' or (select count(*) from jsonb_object_keys(v_given))<>2 or not (v_given ?& array['qid','given']) or length(btrim(coalesce(v_given->>'given','')))<1 or length(v_given->>'given')>2000 then raise exception 'Invalid submitted answer'; end if;
      v_correct:=false;
      if v_kind='question_bank' then
        v_correct:=public.student_exam_answer_matches(v_given->>'given',v_question->>'answer');
        v_result_answers:=v_result_answers||jsonb_build_array(jsonb_build_object('qid',v_qid,'question',coalesce(v_question->>'question',v_question->>'q','السؤال'),'type','essay','given',btrim(v_given->>'given'),'isCorrect',v_correct,'leaderReviewed',false,'awardedPoints',0));
      else
        if v_question->>'type'='essay' then
          v_result_answers:=v_result_answers||jsonb_build_array(jsonb_build_object('qid',v_qid,'question',coalesce(v_question->>'q',v_question->>'question','سؤال الاختبار'),'type','essay','given',btrim(v_given->>'given'),'isCorrect',null,'leaderReviewed',false,'awardedPoints',0));
        else
          v_correct:=btrim(v_given->>'given')=coalesce(v_question->>'answer','');
          v_result_answers:=v_result_answers||jsonb_build_array(jsonb_build_object('qid',v_qid,'question',coalesce(v_question->>'q',v_question->>'question','سؤال الاختبار'),'type',coalesce(v_question->>'type','multiple'),'given',btrim(v_given->>'given'),'isCorrect',v_correct,'leaderReviewed',true,'awardedPoints',0));
        end if;
      end if;
      if v_correct then v_score:=v_score+1; end if;
      v_seen:=v_seen+1;
    end loop;
    begin
      insert into public.student_exam_attempts(attempt_id,owner_legacy_id,owner_auth_user_id,exam_kind,exam_id,answers,score,points_awarded,status,attachment_path,attachment_mime)
      values(p_attempt_id,v_actor,p_auth_user_id,v_kind,v_exam_id,v_result_answers,v_score,0,'submitted',p_attachment_path,p_attachment_mime);
    exception when unique_violation then return jsonb_build_object('ok',true,'duplicate',true); end;
    return jsonb_build_object('ok',true,'attemptId',p_attempt_id,'result',jsonb_build_object('examId',v_exam_id,'answers',v_result_answers,'score',v_score,'total',jsonb_array_length(v_questions),'points',0,'date',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;

  if p_op='redo' then
    select * into v_attempt from public.student_exam_attempts a where a.owner_legacy_id=v_actor and a.exam_kind=v_kind and a.exam_id=v_exam_id and a.status='submitted' for update;
    if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
    v_old_points:=v_attempt.points_awarded;
    if v_kind='question_bank' and v_old_points<>0 then
      select s.version,s.data->>'value' into v_users_version,v_users_raw from public.shared s where s.id='users' for update;
      begin v_users:=v_users_raw::jsonb; exception when others then raise exception 'Malformed users'; end;
      select count(*) into v_matches from jsonb_array_elements(v_users) u where u->>'id'=v_actor;
      if v_matches<>1 then raise exception 'Student state unavailable'; end if;
      select u into v_user from jsonb_array_elements(v_users) u where u->>'id'=v_actor;
      v_user_next:=v_user||jsonb_build_object('points',coalesce(nullif(v_user->>'points','')::numeric,0)-v_old_points,'totalPoints',greatest(0,coalesce(nullif(v_user->>'totalPoints','')::numeric,0)-v_old_points));
      select jsonb_agg(case when u->>'id'=v_actor then v_user_next else u end order by ord) into v_next_users from jsonb_array_elements(v_users) with ordinality x(u,ord);
      update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_next_users::text),true),version=version+1,updated_at=now() where id='users' and version=v_users_version;
      get diagnostics v_updated=row_count; if v_updated<>1 then raise exception 'Concurrent user update'; end if;
    end if;
    update public.student_exam_attempts set status='redone',reviewed_at=now(),reviewed_by=v_actor,attachment_path=null,attachment_mime=null where attempt_id=v_attempt.attempt_id;
    return jsonb_build_object('ok',true,'result',jsonb_build_object('status','redone','delete_path',v_attempt.attachment_path));
  end if;

  if p_op='grade' then
    if not v_is_leader or p_target_user_id is null or length(p_target_user_id)>160 or p_qid is null or p_points is null or p_points not in (0,2,4,6,8,10) then return jsonb_build_object('ok',false,'forbidden',true); end if;
    select * into v_target from public.student_exam_attempts a where a.owner_legacy_id=p_target_user_id and a.exam_kind=v_kind and a.exam_id=v_exam_id and a.status='submitted' for update;
    if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
    select a into v_answer from jsonb_array_elements(v_target.answers) a where a->>'qid'=p_qid limit 1;
    if v_answer is null then return jsonb_build_object('ok',false,'conflict',true); end if;
    v_old_points:=coalesce((v_answer->>'awardedPoints')::integer,0);
    v_answer:=v_answer||jsonb_build_object('awardedPoints',p_points,'leaderReviewed',true,'leaderMark',p_points>0,'awarded',p_points>0);
    select jsonb_agg(case when a->>'qid'=p_qid then v_answer else a end order by ord) into v_answers from jsonb_array_elements(v_target.answers) with ordinality x(a,ord);
    select coalesce(sum((a->>'awardedPoints')::integer),0) into v_points from jsonb_array_elements(v_answers) a;
    select coalesce(sum(case when a->>'isCorrect'='true' then 1 else 0 end),0) into v_score from jsonb_array_elements(v_answers) a;
    if v_kind='question_bank' and v_points<>v_old_points then
      select s.version,s.data->>'value' into v_users_version,v_users_raw from public.shared s where s.id='users' for update;
      begin v_users:=v_users_raw::jsonb; exception when others then raise exception 'Malformed users'; end;
      select count(*) into v_matches from jsonb_array_elements(v_users) u where u->>'id'=p_target_user_id;
      if v_matches<>1 then return jsonb_build_object('ok',false,'conflict',true); end if;
      select u into v_user from jsonb_array_elements(v_users) u where u->>'id'=p_target_user_id;
      v_delta:=p_points-v_old_points;
      v_user_next:=v_user||jsonb_build_object('points',coalesce(nullif(v_user->>'points','')::numeric,0)+v_delta,'totalPoints',greatest(0,coalesce(nullif(v_user->>'totalPoints','')::numeric,0)+v_delta));
      select jsonb_agg(case when u->>'id'=p_target_user_id then v_user_next else u end order by ord) into v_next_users from jsonb_array_elements(v_users) with ordinality x(u,ord);
      update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_next_users::text),true),version=version+1,updated_at=now() where id='users' and version=v_users_version;
      get diagnostics v_updated=row_count; if v_updated<>1 then raise exception 'Concurrent user update'; end if;
    end if;
    update public.student_exam_attempts set answers=v_answers,score=v_score,points_awarded=v_points,reviewed_at=now(),reviewed_by=v_actor where attempt_id=v_target.attempt_id;
    return jsonb_build_object('ok',true,'result',jsonb_build_object('studentId',p_target_user_id,'qid',p_qid,'points',v_points,'score',v_score));
  end if;
  raise exception 'Unsupported exam operation';
end;
$$;

revoke all on function public.student_exams_action(uuid,text,text,text,text,text,jsonb,integer,text,text,jsonb,uuid,text,text) from public, anon, authenticated;
grant execute on function public.student_exams_action(uuid,text,text,text,text,text,jsonb,integer,text,text,jsonb,uuid,text,text) to service_role;
commit;
