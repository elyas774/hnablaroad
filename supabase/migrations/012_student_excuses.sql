-- Keep the independent excuse workflow separate from date-range leave requests.
-- All student text, review state, and attachment paths remain behind the feature gateway.
begin;

create table if not exists public.student_excuse_requests (
  request_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  owner_display_name text not null,
  excuse_type text not null check (excuse_type in ('تأخر','غياب','أخرى')),
  excuse_text text not null check (length(btrim(excuse_text)) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  attachment_path text,
  attachment_mime text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  constraint student_excuse_attachment_pair check (
    (attachment_path is null and attachment_mime is null) or
    (attachment_path is not null and attachment_mime in ('image/jpeg','image/png','image/webp','application/pdf'))
  )
);
create index if not exists student_excuse_owner_recent
  on public.student_excuse_requests(owner_legacy_id, created_at desc);
create index if not exists student_excuse_pending_recent
  on public.student_excuse_requests(created_at desc) where status='pending';
alter table public.student_excuse_requests enable row level security;
revoke all on table public.student_excuse_requests from public, anon, authenticated, service_role;

create or replace function public.student_excuses_action(
  p_auth_user_id uuid,
  p_op text,
  p_request_id uuid,
  p_target_user_id text,
  p_type text,
  p_text text,
  p_decision text,
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
  v_request public.student_excuse_requests%rowtype;
  v_item jsonb;
  v_items jsonb;
  v_deleted integer := 0;
  v_legacy_raw text;
  v_legacy jsonb;
  v_legacy_next jsonb;
  v_legacy_removed integer := 0;
begin
  if p_auth_user_id is null or p_op not in ('mine','review_queue','submit','review','attachment_url','delete_owner') then
    raise exception 'Invalid excuse operation';
  end if;
  select u.legacy_id,coalesce(nullif(u.display_name,''),nullif(u.username,''),u.legacy_id)
    into v_actor,v_actor_name
    from public.app_users u
   where u.auth_user_id=p_auth_user_id and u.needs_password_reset=false;
  if v_actor is null then return jsonb_build_object('ok',false,'forbidden',true); end if;

  select s.data->>'value' into v_leader_raw from public.shared s where s.id='weekLeaderId' for share;
  if v_leader_raw is not null then
    begin v_leader:=v_leader_raw::jsonb #>> '{}'; exception when others then v_leader:=v_leader_raw; end;
  end if;
  v_is_leader:=coalesce(v_leader=v_actor,false);

  if p_op='mine' or p_op='review_queue' then
    if p_op='review_queue' and not v_is_leader then return jsonb_build_object('ok',false,'forbidden',true); end if;
    if p_op='mine' then
      select coalesce(jsonb_agg(q.item order by q.created_at desc),'[]'::jsonb) into v_items from (
        select r.created_at,jsonb_build_object(
          'id',r.request_id,'userId',r.owner_legacy_id,'authorName',r.owner_display_name,
          'type',r.excuse_type,'text',r.excuse_text,
          'date',to_char(r.created_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),
          'createdAt',r.created_at,'status',r.status,'reviewedBy',r.decided_by,'reviewedAt',r.decided_at,
          'attachment_path',r.attachment_path
        ) item from public.student_excuse_requests r where r.owner_legacy_id=v_actor
        order by r.created_at desc limit 100
      ) q;
    else
      select coalesce(jsonb_agg(q.item order by q.created_at desc),'[]'::jsonb) into v_items from (
        select r.created_at,jsonb_build_object(
          'id',r.request_id,'userId',r.owner_legacy_id,'authorName',r.owner_display_name,
          'type',r.excuse_type,'text',r.excuse_text,
          'date',to_char(r.created_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),
          'createdAt',r.created_at,'status',r.status,'reviewedBy',r.decided_by,'reviewedAt',r.decided_at,
          'attachment_path',r.attachment_path
        ) item from public.student_excuse_requests r order by r.created_at desc limit 300
      ) q;
    end if;
    return jsonb_build_object('ok',true,'items',coalesce(v_items,'[]'::jsonb));
  end if;

  if p_op='attachment_url' then
    if p_request_id is null then raise exception 'Invalid excuse request'; end if;
    select * into v_request from public.student_excuse_requests r where r.request_id=p_request_id;
    if not found or v_request.attachment_path is null or (v_request.owner_legacy_id<>v_actor and not v_is_leader) then
      return jsonb_build_object('ok',false);
    end if;
    return jsonb_build_object('ok',true,'attachment_path',v_request.attachment_path);
  end if;

  if p_op='submit' then
    if p_request_id is null or p_type not in ('تأخر','غياب','أخرى') or p_text is null or length(btrim(p_text)) not between 1 and 1000 or
       ((p_attachment_path is null)<>(p_attachment_mime is null)) then
      raise exception 'Invalid excuse request';
    end if;
    if p_attachment_path is not null then
      if p_attachment_mime not in ('image/jpeg','image/png','image/webp','application/pdf') or
         p_attachment_path !~ ('^'||p_auth_user_id::text||'/'||p_request_id::text||'\.(jpg|png|webp|pdf)$') or
         (p_attachment_mime='image/jpeg' and right(p_attachment_path,4)<>'.jpg') or
         (p_attachment_mime='image/png' and right(p_attachment_path,4)<>'.png') or
         (p_attachment_mime='image/webp' and right(p_attachment_path,5)<>'.webp') or
         (p_attachment_mime='application/pdf' and right(p_attachment_path,4)<>'.pdf') then
        raise exception 'Invalid private excuse attachment';
      end if;
    end if;
    insert into public.student_excuse_requests(
      request_id,owner_legacy_id,owner_auth_user_id,owner_display_name,excuse_type,excuse_text,
      status,attachment_path,attachment_mime,created_at,updated_at
    ) values (
      p_request_id,v_actor,p_auth_user_id,v_actor_name,p_type,btrim(p_text),
      'pending',p_attachment_path,p_attachment_mime,now(),now()
    );
    select jsonb_build_object(
      'id',p_request_id,'userId',v_actor,'authorName',v_actor_name,'type',p_type,'text',btrim(p_text),
      'date',to_char(now() at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),'createdAt',now(),
      'status','pending','reviewedBy',null,'reviewedAt',null,'attachment_path',p_attachment_path
    ) into v_item;
    return jsonb_build_object('ok',true,'item',v_item);
  end if;

  if p_op='review' then
    if not v_is_leader then return jsonb_build_object('ok',false,'forbidden',true); end if;
    if p_request_id is null or p_decision not in ('approved','rejected') then raise exception 'Invalid excuse decision'; end if;
    update public.student_excuse_requests r set status=p_decision,updated_at=now(),decided_at=now(),decided_by=v_actor_name
      where r.request_id=p_request_id and r.status='pending'
      returning r.* into v_request;
    if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
    select jsonb_build_object(
      'id',v_request.request_id,'userId',v_request.owner_legacy_id,'authorName',v_request.owner_display_name,
      'type',v_request.excuse_type,'text',v_request.excuse_text,
      'date',to_char(v_request.created_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),
      'createdAt',v_request.created_at,'status',v_request.status,'reviewedBy',v_request.decided_by,'reviewedAt',v_request.decided_at,
      'attachment_path',v_request.attachment_path
    ) into v_item;
    return jsonb_build_object('ok',true,'item',v_item);
  end if;

  if p_op='delete_owner' then
    if not v_is_leader then return jsonb_build_object('ok',false,'forbidden',true); end if;
    if p_target_user_id is null or length(p_target_user_id) not between 1 and 160 or p_target_user_id=v_actor or p_target_user_id=v_leader then
      raise exception 'Invalid account cleanup';
    end if;
    delete from public.student_excuse_requests r where r.owner_legacy_id=p_target_user_id;
    get diagnostics v_deleted=row_count;
    select s.data->>'value' into v_legacy_raw from public.shared s where s.id='excuses' for update;
    if v_legacy_raw is not null then
      begin v_legacy:=v_legacy_raw::jsonb; exception when others then v_legacy:=null; end;
      if jsonb_typeof(v_legacy)='array' then
        select coalesce(jsonb_agg(e.value order by e.ordinality),'[]'::jsonb) into v_legacy_next
          from jsonb_array_elements(v_legacy) with ordinality e(value,ordinality)
         where e.value->>'userId' is distinct from p_target_user_id;
        v_legacy_removed:=jsonb_array_length(v_legacy)-jsonb_array_length(v_legacy_next);
        update public.shared s set data=jsonb_set(s.data,'{value}',to_jsonb(v_legacy_next::text),true),version=s.version+1,updated_at=now()
          where s.id='excuses';
      end if;
    end if;
    return jsonb_build_object('ok',true,'deletedCount',v_deleted,'legacyDeletedCount',v_legacy_removed);
  end if;

  raise exception 'Unsupported excuse operation';
end;
$$;
revoke all on function public.student_excuses_action(uuid,text,uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.student_excuses_action(uuid,text,uuid,text,text,text,text,text,text) to service_role;
commit;
