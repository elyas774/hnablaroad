-- The pre-existing ensure_rls event trigger keeps enabling RLS on public tables.
-- Its SECURITY DEFINER function must not be exposed as a callable public RPC.
begin;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
commit;
