begin;

alter table public.rewrite_requests
  drop constraint rewrite_requests_provider_check;

alter table public.rewrite_requests
  add constraint rewrite_requests_provider_check
  check (provider in ('ebond', 'wenwen'));

create or replace function public.begin_rewrite_request(
  p_user_id uuid,
  p_request_id uuid,
  p_input_sha256 text,
  p_input_characters bigint,
  p_prompt_version text,
  p_provider text,
  p_model text
)
returns table (
  request_id uuid,
  claim_state text,
  usage_period_id uuid,
  allowance_characters bigint,
  reserved_characters bigint,
  consumed_characters bigint,
  remaining_characters bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_inserted boolean := false;
  v_existing public.rewrite_requests%rowtype;
  v_quota record;
  v_period public.usage_periods%rowtype;
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'REWRITE_ARGUMENT_REQUIRED';
  end if;

  if p_input_characters <= 0
    or p_input_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(btrim(p_prompt_version), '') is null
    or p_provider <> 'wenwen'
    or nullif(btrim(p_model), '') is null
  then
    raise exception using errcode = '22023', message = 'INVALID_REWRITE_ARGUMENT';
  end if;

  insert into public.rewrite_requests (
    user_id,
    request_id,
    input_sha256,
    input_characters,
    prompt_version,
    provider,
    model
  )
  values (
    p_user_id,
    p_request_id,
    p_input_sha256,
    p_input_characters,
    p_prompt_version,
    p_provider,
    p_model
  )
  on conflict on constraint rewrite_requests_pkey do nothing
  returning true into v_was_inserted;

  if v_was_inserted then
    select *
    into strict v_quota
    from public.reserve_quota(p_user_id, p_request_id, p_input_characters);

    update public.rewrite_requests as rr
    set usage_period_id = v_quota.usage_period_id
    where rr.user_id = p_user_id and rr.request_id = p_request_id;

    return query select
      p_request_id,
      'claimed'::text,
      v_quota.usage_period_id,
      v_quota.allowance_characters,
      v_quota.reserved_characters,
      v_quota.consumed_characters,
      v_quota.remaining_characters;
    return;
  end if;

  select rr.*
  into strict v_existing
  from public.rewrite_requests as rr
  where rr.user_id = p_user_id and rr.request_id = p_request_id
  for update;

  if v_existing.input_sha256 <> p_input_sha256
    or v_existing.input_characters <> p_input_characters
    or v_existing.prompt_version <> p_prompt_version
    or v_existing.provider <> p_provider
    or v_existing.model <> p_model
  then
    raise exception using errcode = 'P0001', message = 'REQUEST_ID_CONFLICT';
  end if;

  select up.*
  into strict v_period
  from public.usage_periods as up
  where up.id = v_existing.usage_period_id;

  return query select
    p_request_id,
    v_existing.status,
    v_existing.usage_period_id,
    v_period.base_allowance + v_period.adjustment_characters,
    v_period.reserved_characters,
    v_period.consumed_characters,
    v_period.base_allowance + v_period.adjustment_characters
      - v_period.reserved_characters - v_period.consumed_characters;
end;
$$;

commit;
