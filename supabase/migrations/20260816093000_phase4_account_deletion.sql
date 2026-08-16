begin;

create or replace function public.anonymize_deleted_member(
  p_user_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'ACCOUNT_DELETE_ARGUMENT_REQUIRED';
  end if;

  update public.profiles as p
  set
    display_name = null,
    role = 'member',
    status = 'suspended'
  where p.id = p_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_NOT_INITIALIZED';
  end if;

  insert into public.admin_audit_logs (
    administrator_id,
    action,
    target_user_id,
    reason,
    request_id,
    metadata
  )
  values (
    null,
    'account.delete',
    p_user_id,
    'self-service account deletion',
    p_request_id,
    '{}'::jsonb
  )
  on conflict (request_id) do nothing;
end;
$$;

revoke all on function public.anonymize_deleted_member(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.anonymize_deleted_member(uuid, uuid) to service_role;

commit;
