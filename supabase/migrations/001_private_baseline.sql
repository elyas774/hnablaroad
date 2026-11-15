-- طريق الحنابلة: private-first Supabase migration schema
-- Apply as the project owner. No anon/authenticated client access is granted.
-- The Firestore source remains untouched. Never add permissive browser policies here.

begin;

create table if not exists public.shared (
  id text primary key,
  data jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id text primary key,
  data jsonb not null,
  version bigint not null default 1,
  date text,
  updated_at timestamptz not null default now()
);

-- Maps stable legacy app IDs to Supabase Auth UUIDs without carrying legacy passwords.
create table if not exists public.app_users (
  legacy_id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  username text not null unique,
  display_name text not null default '',
  profile jsonb not null default '{}'::jsonb,
  needs_password_reset boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared enable row level security;
alter table public.chat_messages enable row level security;
alter table public.app_users enable row level security;

-- Explicit table revokes. Browser reads/writes go only through the reviewed server gateway.
revoke all on table public.shared, public.chat_messages, public.app_users from public, anon, authenticated;

-- Compatibility RPCs retained but inaccessible to browser roles.
create or replace function public.shared_cas(p_id text, p_expected bigint, p_data jsonb)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  affected integer;
begin
  update public.shared
     set data = p_data,
         version = version + 1,
         updated_at = now()
   where id = p_id and version = p_expected;
  get diagnostics affected = row_count;
  if affected = 1 then return true; end if;

  if p_expected = 0 then
    insert into public.shared(id, data, version, updated_at)
    values (p_id, p_data, 1, now())
    on conflict (id) do nothing;
    get diagnostics affected = row_count;
    return affected = 1;
  end if;
  return false;
end;
$$;

create or replace function public.doc_patch(p_table text, p_id text, p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_table = 'shared' then
    update public.shared
       set data = data || p_patch,
           version = version + 1,
           updated_at = now()
     where id = p_id;
  elsif p_table = 'chat_messages' then
    update public.chat_messages
       set data = data || p_patch,
           date = coalesce(p_patch ->> 'date', date),
           version = version + 1,
           updated_at = now()
     where id = p_id;
  else
    raise exception 'Unsupported table for doc_patch';
  end if;
  if not found then raise exception 'Document not found'; end if;
end;
$$;

create or replace function public.chat_mark_seen(p_ids text[], p_user text)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.app_users u
     where u.auth_user_id = auth.uid() and u.legacy_id = p_user
  ) then
    raise exception 'Authenticated identity does not match p_user';
  end if;

  update public.chat_messages m
     set data = jsonb_set(
       m.data,
       '{seenBy}',
       (case when jsonb_typeof(m.data -> 'seenBy') = 'array'
             then m.data -> 'seenBy' else '[]'::jsonb end) || to_jsonb(p_user),
       true
     ),
     version = version + 1,
     updated_at = now()
   where m.id = any(p_ids)
     and not coalesce((m.data -> 'seenBy') ? p_user, false);
end;
$$;

revoke execute on function public.shared_cas(text, bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.doc_patch(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.chat_mark_seen(text[], text) from public, anon, authenticated;

-- Enable Realtime table publication if it exists, without granting direct table access.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='shared') then
      execute 'alter publication supabase_realtime add table public.shared';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then
      execute 'alter publication supabase_realtime add table public.chat_messages';
    end if;
  end if;
end;
$$;

commit;
