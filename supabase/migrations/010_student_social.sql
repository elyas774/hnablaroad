-- Server-authoritative text feed, comments, and reactions. No public storage or browser table access.
begin;

create table if not exists public.student_social_posts (
  post_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  author_name text not null check (length(author_name) between 1 and 120),
  post_text text not null check (length(btrim(post_text)) between 1 and 2000),
  post_type text not null default 'manual' check (post_type = 'manual'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);
create index if not exists student_social_posts_recent on public.student_social_posts(created_at desc, post_id);
create index if not exists student_social_posts_owner on public.student_social_posts(owner_legacy_id, created_at desc);

create table if not exists public.student_social_comments (
  comment_id uuid primary key,
  post_id uuid not null references public.student_social_posts(post_id) on delete cascade,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  author_name text not null check (length(author_name) between 1 and 120),
  comment_text text not null check (length(btrim(comment_text)) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);
create index if not exists student_social_comments_post_recent on public.student_social_comments(post_id, created_at desc);
create index if not exists student_social_comments_owner on public.student_social_comments(owner_legacy_id, created_at desc);

create table if not exists public.student_social_reactions (
  post_id uuid not null references public.student_social_posts(post_id) on delete cascade,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  emoji text not null check (emoji in ('🤲','✨','👍','🤍')),
  created_at timestamptz not null default now(),
  primary key (post_id, owner_auth_user_id)
);

-- A transaction-scoped idempotency ledger prevents retries/double clicks from duplicating actions.
create table if not exists public.student_social_requests (
  owner_auth_user_id uuid not null,
  request_id uuid not null,
  operation text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_auth_user_id, request_id)
);
create index if not exists student_social_requests_created on public.student_social_requests(created_at);

alter table public.student_social_posts enable row level security;
alter table public.student_social_comments enable row level security;
alter table public.student_social_reactions enable row level security;
alter table public.student_social_requests enable row level security;
revoke all on table public.student_social_posts, public.student_social_comments,
  public.student_social_reactions, public.student_social_requests
  from public, anon, authenticated, service_role;

create or replace function public.student_social_action(
  p_auth_user_id uuid,
  p_op text,
  p_post_id uuid,
  p_comment_id uuid,
  p_request_id uuid,
  p_text text,
  p_emoji text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text;
  v_actor_name text;
  v_user_data jsonb;
  v_users jsonb;
  v_user_matches integer;
  v_user jsonb;
  v_leader_value jsonb;
  v_leader text;
  v_is_leader boolean := false;
  v_mutating boolean;
  v_claimed integer;
  v_prior_op text;
  v_prior_result jsonb;
  v_post public.student_social_posts%rowtype;
  v_comment public.student_social_comments%rowtype;
  v_result jsonb;
  v_items jsonb;
  v_reactions jsonb;
  v_comments jsonb;
  v_name text;
begin
  if p_auth_user_id is null or p_op not in ('feed','create_post','edit_post','delete_post','create_comment','edit_comment','delete_comment','toggle_reaction') then
    raise exception 'Invalid social operation';
  end if;
  select u.legacy_id into v_actor
    from public.app_users u
   where u.auth_user_id=p_auth_user_id and u.needs_password_reset=false;
  if v_actor is null then raise exception 'Account not linked or password reset required'; end if;

  -- Lock the canonical shared profile. shared.value is JSON text, not a nested JSON array.
  select (s.data->>'value')::jsonb into v_users
    from public.shared s where s.id='users' for share;
  if jsonb_typeof(v_users)<>'array' then raise exception 'User state unavailable'; end if;
  select count(*) into v_user_matches from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_actor;
  if v_user_matches<>1 then raise exception 'Actor state unavailable'; end if;
  select e.user_row into v_user from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_actor limit 1;
  v_actor_name:=left(coalesce(nullif(v_user->>'name',''),nullif(v_user->>'displayName',''),v_actor),120);
  if length(btrim(v_actor_name))=0 then v_actor_name:=v_actor; end if;

  -- Leadership is derived from the current shared weekLeaderId under a row lock, never from request data.
  select s.data->'value' into v_leader_value
    from public.shared s where s.id='weekLeaderId' for share;
  if jsonb_typeof(v_leader_value)='string' then v_leader:=v_leader_value #>> '{}';
  elsif v_leader_value is not null then v_leader:=v_leader_value::text; end if;
  v_is_leader:=coalesce(v_leader=v_actor,false);

  if p_op='feed' then
    select coalesce(jsonb_agg(q.item order by q.created_at desc),'[]'::jsonb) into v_items
      from (
        select p.created_at,
          jsonb_build_object(
            'id',p.post_id,'userId',p.owner_legacy_id,'authorName',p.author_name,
            'text',p.post_text,'type',p.post_type,'date',p.created_at,
            'updatedAt',p.updated_at,'version',p.version,
            'reactions',coalesce(r.items,'[]'::jsonb),
            'comments',coalesce(c.items,'[]'::jsonb)
          ) as item
          from public.student_social_posts p
          left join lateral (
            select coalesce(jsonb_agg(jsonb_build_object('emoji',x.emoji,'count',x.n,'mine',x.mine) order by x.emoji),'[]'::jsonb) items
              from (
                select z.emoji,count(*)::integer n,bool_or(z.owner_auth_user_id=p_auth_user_id) mine
                  from public.student_social_reactions z where z.post_id=p.post_id group by z.emoji
              ) x
          ) r on true
          left join lateral (
            select coalesce(jsonb_agg(x.item order by x.created_at asc),'[]'::jsonb) items
              from (
                select y.created_at,jsonb_build_object('id',y.comment_id,'userId',y.owner_legacy_id,
                  'authorName',y.author_name,'text',y.comment_text,'date',y.created_at,
                  'updatedAt',y.updated_at,'version',y.version) item
                  from public.student_social_comments y where y.post_id=p.post_id
                  order by y.created_at desc,y.comment_id desc limit 50
              ) x
          ) c on true
          order by p.created_at desc,p.post_id desc limit 100
      ) q;
    return jsonb_build_object('ok',true,'posts',v_items);
  end if;

  if p_request_id is null then raise exception 'Missing idempotency key'; end if;
  insert into public.student_social_requests(owner_auth_user_id,request_id,operation)
    values(p_auth_user_id,p_request_id,p_op) on conflict(owner_auth_user_id,request_id) do nothing;
  get diagnostics v_claimed=row_count;
  if v_claimed=0 then
    select r.operation,r.result into v_prior_op,v_prior_result
      from public.student_social_requests r
     where r.owner_auth_user_id=p_auth_user_id and r.request_id=p_request_id;
    if v_prior_op is distinct from p_op then return jsonb_build_object('ok',false,'conflict',true); end if;
    if v_prior_result is not null then return v_prior_result; end if;
    return jsonb_build_object('ok',false,'conflict',true);
  end if;

  if p_op='create_post' then
    if p_post_id is null or p_comment_id is not null or p_emoji is not null or p_expected_version is not null or
       p_text is null or length(btrim(p_text)) not between 1 and 2000 or
       translate(p_text,E'\n\r\t','') ~ '[[:cntrl:]]' then
      v_result:=jsonb_build_object('ok',false,'invalid',true);
    else
      insert into public.student_social_posts(post_id,owner_legacy_id,owner_auth_user_id,author_name,post_text,post_type)
      values(p_post_id,v_actor,p_auth_user_id,v_actor_name,btrim(p_text),'manual');
      v_result:=jsonb_build_object('ok',true,'status','created','postId',p_post_id,'version',1);
    end if;
  elsif p_op='edit_post' then
    select p.* into v_post from public.student_social_posts p where p.post_id=p_post_id for update;
    if not found then v_result:=jsonb_build_object('ok',false,'not_found',true);
    elsif v_post.owner_auth_user_id<>p_auth_user_id then v_result:=jsonb_build_object('ok',false,'forbidden',true);
    elsif p_expected_version is null or v_post.version<>p_expected_version then v_result:=jsonb_build_object('ok',false,'conflict',true);
    elsif p_text is null or length(btrim(p_text)) not between 1 and 2000 or translate(p_text,E'\n\r\t','') ~ '[[:cntrl:]]' then v_result:=jsonb_build_object('ok',false,'invalid',true);
    else
      update public.student_social_posts set post_text=btrim(p_text),updated_at=now(),version=version+1 where post_id=p_post_id;
      v_result:=jsonb_build_object('ok',true,'status','updated','postId',p_post_id,'version',p_expected_version+1);
    end if;
  elsif p_op='delete_post' then
    select p.* into v_post from public.student_social_posts p where p.post_id=p_post_id for update;
    if not found then v_result:=jsonb_build_object('ok',false,'not_found',true);
    elsif v_post.owner_auth_user_id<>p_auth_user_id and not v_is_leader then v_result:=jsonb_build_object('ok',false,'forbidden',true);
    elsif p_expected_version is null or v_post.version<>p_expected_version then v_result:=jsonb_build_object('ok',false,'conflict',true);
    else
      delete from public.student_social_posts where post_id=p_post_id;
      v_result:=jsonb_build_object('ok',true,'status','deleted','postId',p_post_id);
    end if;
  elsif p_op='create_comment' then
    select p.* into v_post from public.student_social_posts p where p.post_id=p_post_id for update;
    if not found then v_result:=jsonb_build_object('ok',false,'not_found',true);
    elsif p_comment_id is null or p_text is null or length(btrim(p_text)) not between 1 and 500 or
          translate(p_text,E'\n\r\t','') ~ '[[:cntrl:]]' then v_result:=jsonb_build_object('ok',false,'invalid',true);
    else
      insert into public.student_social_comments(comment_id,post_id,owner_legacy_id,owner_auth_user_id,author_name,comment_text)
      values(p_comment_id,p_post_id,v_actor,p_auth_user_id,v_actor_name,btrim(p_text));
      v_result:=jsonb_build_object('ok',true,'status','created','commentId',p_comment_id,'version',1);
    end if;
  elsif p_op='edit_comment' then
    select c.* into v_comment from public.student_social_comments c where c.comment_id=p_comment_id for update;
    if not found then v_result:=jsonb_build_object('ok',false,'not_found',true);
    elsif v_comment.owner_auth_user_id<>p_auth_user_id then v_result:=jsonb_build_object('ok',false,'forbidden',true);
    elsif p_expected_version is null or v_comment.version<>p_expected_version then v_result:=jsonb_build_object('ok',false,'conflict',true);
    elsif p_text is null or length(btrim(p_text)) not between 1 and 500 or translate(p_text,E'\n\r\t','') ~ '[[:cntrl:]]' then v_result:=jsonb_build_object('ok',false,'invalid',true);
    else
      update public.student_social_comments set comment_text=btrim(p_text),updated_at=now(),version=version+1 where comment_id=p_comment_id;
      v_result:=jsonb_build_object('ok',true,'status','updated','commentId',p_comment_id,'version',p_expected_version+1);
    end if;
  elsif p_op='delete_comment' then
    select c.* into v_comment from public.student_social_comments c where c.comment_id=p_comment_id for update;
    if not found then v_result:=jsonb_build_object('ok',false,'not_found',true);
    elsif v_comment.owner_auth_user_id<>p_auth_user_id and not v_is_leader then v_result:=jsonb_build_object('ok',false,'forbidden',true);
    elsif p_expected_version is null or v_comment.version<>p_expected_version then v_result:=jsonb_build_object('ok',false,'conflict',true);
    else
      delete from public.student_social_comments where comment_id=p_comment_id;
      v_result:=jsonb_build_object('ok',true,'status','deleted','commentId',p_comment_id);
    end if;
  elsif p_op='toggle_reaction' then
    select p.* into v_post from public.student_social_posts p where p.post_id=p_post_id for update;
    if not found then v_result:=jsonb_build_object('ok',false,'not_found',true);
    elsif p_emoji not in ('🤲','✨','👍','🤍') then v_result:=jsonb_build_object('ok',false,'invalid',true);
    else
      select r.emoji into v_name from public.student_social_reactions r where r.post_id=p_post_id and r.owner_auth_user_id=p_auth_user_id for update;
      if found and v_name=p_emoji then
        delete from public.student_social_reactions where post_id=p_post_id and owner_auth_user_id=p_auth_user_id;
        v_result:=jsonb_build_object('ok',true,'status','removed','emoji',p_emoji);
      else
        insert into public.student_social_reactions(post_id,owner_legacy_id,owner_auth_user_id,emoji)
        values(p_post_id,v_actor,p_auth_user_id,p_emoji)
        on conflict(post_id,owner_auth_user_id) do update set emoji=excluded.emoji,created_at=now();
        v_result:=jsonb_build_object('ok',true,'status','set','emoji',p_emoji);
      end if;
    end if;
  end if;

  update public.student_social_requests set result=v_result
   where owner_auth_user_id=p_auth_user_id and request_id=p_request_id;
  return v_result;
end;
$$;

revoke all on function public.student_social_action(uuid,text,uuid,uuid,uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.student_social_action(uuid,text,uuid,uuid,uuid,text,text,integer) to service_role;

commit;
