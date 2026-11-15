-- Private individual leave requests; all state transitions are atomic and Auth-linked.
begin;

create table if not exists public.student_leave_requests (
  request_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  owner_display_name text not null,
  start_date date not null,
  end_date date not null,
  request_type text not null check (request_type in ('عادية','طارئة','مرضية','دراسة','ظرف خاص')),
  leave_mode text not null check (leave_mode in ('full','light','meetings','custom')),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  protect_streak boolean not null,
  rules jsonb not null check (jsonb_typeof(rules) = 'object'),
  status text not null check (status in ('pending','approved','rejected','cancelled')),
  attachment_path text,
  attachment_mime text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  cancelled_at timestamptz,
  constraint student_leave_dates_ordered check (end_date >= start_date),
  constraint student_leave_attachment_pair check (
    (attachment_path is null and attachment_mime is null) or
    (attachment_path is not null and attachment_mime in ('image/jpeg','image/png','image/webp','application/pdf'))
  )
);
create index if not exists student_leave_owner_recent
  on public.student_leave_requests(owner_legacy_id, created_at desc);
create index if not exists student_leave_pending_recent
  on public.student_leave_requests(created_at asc) where status = 'pending';
create index if not exists student_leave_owner_approved_dates
  on public.student_leave_requests(owner_legacy_id, start_date, end_date) where status = 'approved';
create unique index if not exists student_leave_no_exact_pending_duplicate
  on public.student_leave_requests(owner_legacy_id, start_date, end_date) where status = 'pending';
alter table public.student_leave_requests enable row level security;
revoke all on table public.student_leave_requests from public, anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('leave-attachments','leave-attachments',false,2097152,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set name=excluded.name, public=false,
  file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists student_leave_attachments_deny_select on storage.objects;
drop policy if exists student_leave_attachments_deny_insert on storage.objects;
drop policy if exists student_leave_attachments_deny_update on storage.objects;
drop policy if exists student_leave_attachments_deny_delete on storage.objects;
create policy student_leave_attachments_deny_select on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'leave-attachments');
create policy student_leave_attachments_deny_insert on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'leave-attachments');
create policy student_leave_attachments_deny_update on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'leave-attachments') with check (bucket_id <> 'leave-attachments');
create policy student_leave_attachments_deny_delete on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'leave-attachments');

create or replace function public.student_leaves_action(
  p_auth_user_id uuid,
  p_op text,
  p_request_id uuid,
  p_start_date date,
  p_end_date date,
  p_type text,
  p_mode text,
  p_reason text,
  p_protect_streak boolean,
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
  v_request public.student_leave_requests%rowtype;
  v_item jsonb;
  v_items jsonb;
  v_rules jsonb;
  v_now timestamptz := now();
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if p_auth_user_id is null or p_op not in ('mine','review_queue','submit','cancel','approve','reject','attachment_url') then
    raise exception 'Invalid leave operation';
  end if;
  select u.legacy_id, coalesce(nullif(u.display_name,''),nullif(u.username,''),u.legacy_id)
    into v_actor, v_actor_name
    from public.app_users u
   where u.auth_user_id=p_auth_user_id and u.needs_password_reset=false;
  if v_actor is null then return jsonb_build_object('ok',false,'forbidden',true); end if;

  select s.data->>'value' into v_leader_raw
    from public.shared s where s.id='weekLeaderId' for share;
  if v_leader_raw is not null then
    begin v_leader := v_leader_raw::jsonb #>> '{}'; exception when others then v_leader := v_leader_raw; end;
  end if;
  v_is_leader := coalesce(v_leader=v_actor,false);
  if p_op='review_queue' and not v_is_leader then return jsonb_build_object('ok',false,'forbidden',true); end if;

  if p_op='mine' or p_op='review_queue' then
    if p_op='mine' then
      select coalesce(jsonb_agg(x.item order by x.created_at desc),'[]'::jsonb) into v_items
      from (
        select r.created_at, jsonb_build_object(
          'id',r.request_id,'requestId',r.request_id,'scope','individual','userId',r.owner_legacy_id,
          'authorName',r.owner_display_name,
          'start',to_char(r.start_date,'YYYY-MM-DD'),'end',to_char(r.end_date,'YYYY-MM-DD'),
          'type',r.request_type,'mode',r.leave_mode,'reason',r.reason,'protectStreak',r.protect_streak,'rules',r.rules,
          'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'approvedAt',r.decided_at,
          'approvedBy',r.decided_by,'attachment_path',r.attachment_path
        ) item from public.student_leave_requests r where r.owner_legacy_id=v_actor order by r.created_at desc limit 100
      ) x;
    else
      select coalesce(jsonb_agg(x.item order by x.created_at asc),'[]'::jsonb) into v_items
      from (
        select r.created_at, jsonb_build_object(
          'id',r.request_id,'requestId',r.request_id,'scope','individual','userId',r.owner_legacy_id,
          'authorName',r.owner_display_name,
          'start',to_char(r.start_date,'YYYY-MM-DD'),'end',to_char(r.end_date,'YYYY-MM-DD'),
          'type',r.request_type,'mode',r.leave_mode,'reason',r.reason,'protectStreak',r.protect_streak,'rules',r.rules,
          'status',r.status,'createdAt',r.created_at,'updatedAt',r.updated_at,'approvedAt',r.decided_at,
          'approvedBy',r.decided_by,'attachment_path',r.attachment_path
        ) item from public.student_leave_requests r order by r.created_at desc limit 100
      ) x;
    end if;
    return jsonb_build_object('ok',true,'items',coalesce(v_items,'[]'::jsonb));
  end if;

  if p_op='attachment_url' then
    if p_request_id is null then raise exception 'Invalid leave request'; end if;
    select * into v_request from public.student_leave_requests r where r.request_id=p_request_id;
    if not found or v_request.attachment_path is null or (v_request.owner_legacy_id<>v_actor and not v_is_leader) then
      return jsonb_build_object('ok',false);
    end if;
    return jsonb_build_object('ok',true,'attachment_path',v_request.attachment_path);
  end if;

  if p_op='submit' then
    if p_request_id is null or p_start_date is null or p_end_date is null or p_end_date<p_start_date or
       p_end_date<v_today or p_type is null or p_type not in ('عادية','طارئة','مرضية','دراسة','ظرف خاص') or
       p_mode is null or p_mode not in ('full','light','meetings','custom') or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 or
       p_protect_streak is null or ((p_attachment_path is null)<>(p_attachment_mime is null)) then
      raise exception 'Invalid leave request';
    end if;
    if p_attachment_path is not null then
      if p_attachment_mime not in ('image/jpeg','image/png','image/webp','application/pdf') or
         p_attachment_path !~ ('^'||p_auth_user_id::text||'/'||p_request_id::text||'\.(jpg|png|webp|pdf)$') or
         (p_attachment_mime='image/jpeg' and right(p_attachment_path,4)<>'.jpg') or
         (p_attachment_mime='image/png' and right(p_attachment_path,4)<>'.png') or
         (p_attachment_mime='image/webp' and right(p_attachment_path,5)<>'.webp') or
         (p_attachment_mime='application/pdf' and right(p_attachment_path,4)<>'.pdf') then
        raise exception 'Invalid private attachment';
      end if;
    end if;

    -- Serialize submissions and approvals per student before checking approved leave overlap.
    perform pg_advisory_xact_lock(hashtext(v_actor));
    if exists(select 1 from public.student_leave_requests r where r.owner_legacy_id=v_actor and r.status='approved'
      and r.start_date<=p_end_date and r.end_date>=p_start_date) then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    if exists(select 1 from public.student_leave_requests r where r.owner_legacy_id=v_actor and r.status='pending'
      and r.start_date=p_start_date and r.end_date=p_end_date) then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    v_rules := case p_mode
      when 'full' then '{"attendance":true,"penalties":true,"streak":true,"tasks":true,"meetings":true,"reminders":true,"absence":true}'::jsonb
      when 'light' then jsonb_build_object('attendance',true,'penalties',true,'streak',p_protect_streak,'tasks',false,'meetings',false,'reminders',false,'absence',true)
      when 'meetings' then '{"attendance":false,"penalties":true,"streak":false,"tasks":false,"meetings":true,"reminders":true,"absence":false}'::jsonb
      else jsonb_build_object('attendance',false,'penalties',false,'streak',p_protect_streak,'tasks',false,'meetings',false,'reminders',false,'absence',false)
    end;
    insert into public.student_leave_requests(
      request_id,owner_legacy_id,owner_auth_user_id,owner_display_name,start_date,end_date,request_type,leave_mode,reason,
      protect_streak,rules,status,attachment_path,attachment_mime,created_at,updated_at
    ) values (
      p_request_id,v_actor,p_auth_user_id,v_actor_name,p_start_date,p_end_date,p_type,p_mode,btrim(p_reason),
      p_protect_streak,v_rules,'pending',p_attachment_path,p_attachment_mime,v_now,v_now
    );
    select jsonb_build_object(
      'id',p_request_id,'requestId',p_request_id,'scope','individual','userId',v_actor,
      'authorName',v_actor_name,'start',to_char(p_start_date,'YYYY-MM-DD'),'end',to_char(p_end_date,'YYYY-MM-DD'),
      'type',p_type,'mode',p_mode,'reason',btrim(p_reason),'protectStreak',p_protect_streak,'rules',v_rules,
      'status','pending','createdAt',v_now,'updatedAt',v_now,'approvedAt',null,'approvedBy',null,'attachment_path',p_attachment_path
    ) into v_item;
    return jsonb_build_object('ok',true,'item',v_item);
  end if;

  if p_op='cancel' then
    if p_request_id is null then raise exception 'Invalid leave request'; end if;
    select * into v_request from public.student_leave_requests r where r.request_id=p_request_id for update;
    if not found or v_request.owner_legacy_id<>v_actor then return jsonb_build_object('ok',false); end if;
    if v_request.status<>'pending' then return jsonb_build_object('ok',false,'conflict',true); end if;
    update public.student_leave_requests r set status='cancelled',updated_at=v_now,cancelled_at=v_now where r.request_id=p_request_id and r.status='pending';
    select jsonb_build_object(
      'id',v_request.request_id,'requestId',v_request.request_id,'scope','individual','userId',v_actor,
      'authorName',v_actor_name,'start',to_char(v_request.start_date,'YYYY-MM-DD'),'end',to_char(v_request.end_date,'YYYY-MM-DD'),
      'type',v_request.request_type,'mode',v_request.leave_mode,'reason',v_request.reason,'protectStreak',v_request.protect_streak,'rules',v_request.rules,
      'status','cancelled','createdAt',v_request.created_at,'updatedAt',v_now,'approvedAt',v_request.decided_at,'approvedBy',v_request.decided_by,'attachment_path',v_request.attachment_path
    ) into v_item;
    return jsonb_build_object('ok',true,'item',v_item);
  end if;

  if p_op='approve' or p_op='reject' then
    if not v_is_leader then return jsonb_build_object('ok',false,'forbidden',true); end if;
    if p_request_id is null then raise exception 'Invalid leave request'; end if;
    select * into v_request from public.student_leave_requests r where r.request_id=p_request_id for update;
    if not found or v_request.status<>'pending' then return jsonb_build_object('ok',false,'conflict',true); end if;
    perform pg_advisory_xact_lock(hashtext(v_request.owner_legacy_id));
    if p_op='approve' and exists(select 1 from public.student_leave_requests r where r.owner_legacy_id=v_request.owner_legacy_id
      and r.status='approved' and r.request_id<>p_request_id and r.start_date<=v_request.end_date and r.end_date>=v_request.start_date) then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    update public.student_leave_requests r set status=case when p_op='approve' then 'approved' else 'rejected' end,
      updated_at=v_now,decided_at=v_now,decided_by=v_actor_name where r.request_id=p_request_id and r.status='pending';
    select jsonb_build_object(
      'id',v_request.request_id,'requestId',v_request.request_id,'scope','individual','userId',v_request.owner_legacy_id,
      'authorName',v_request.owner_display_name,'start',to_char(v_request.start_date,'YYYY-MM-DD'),'end',to_char(v_request.end_date,'YYYY-MM-DD'),
      'type',v_request.request_type,'mode',v_request.leave_mode,'reason',v_request.reason,'protectStreak',v_request.protect_streak,'rules',v_request.rules,
      'status',case when p_op='approve' then 'approved' else 'rejected' end,'createdAt',v_request.created_at,'updatedAt',v_now,
      'approvedAt',v_now,'approvedBy',v_actor_name,'attachment_path',v_request.attachment_path
    ) into v_item;
    return jsonb_build_object('ok',true,'item',v_item);
  end if;

  raise exception 'Unsupported leave operation';
end;
$$;

revoke all on function public.student_leaves_action(uuid,text,uuid,date,date,text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.student_leaves_action(uuid,text,uuid,date,date,text,text,text,boolean,text,text) to service_role;
commit;
