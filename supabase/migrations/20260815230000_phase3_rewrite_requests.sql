begin;

create table public.rewrite_requests (
  user_id uuid not null references public.profiles (id) on delete cascade,
  request_id uuid not null,
  usage_period_id uuid references public.usage_periods (id) on delete cascade,
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  input_characters bigint not null check (input_characters > 0),
  prompt_version text not null check (nullif(btrim(prompt_version), '') is not null),
  provider text not null check (provider = 'ebond'),
  model text not null check (nullif(btrim(model), '') is not null),
  status text not null default 'processing'
    check (status in ('processing', 'succeeded', 'failed')),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  cost_microusd bigint check (cost_microusd >= 0),
  sanitized_error_code text check (
    sanitized_error_code is null or sanitized_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, request_id),
  constraint rewrite_requests_completion_shape check (
    (
      status = 'processing'
      and input_tokens is null
      and output_tokens is null
      and cost_microusd is null
      and sanitized_error_code is null
      and completed_at is null
    )
    or (
      status = 'succeeded'
      and input_tokens is not null
      and output_tokens is not null
      and cost_microusd is not null
      and sanitized_error_code is null
      and completed_at is not null
    )
    or (
      status = 'failed'
      and input_tokens is null
      and output_tokens is null
      and cost_microusd is null
      and sanitized_error_code is not null
      and completed_at is not null
    )
  )
);

-- Only content-free metadata is retained so retries can be identified without storing user text.

create index rewrite_requests_created_idx
  on public.rewrite_requests (created_at desc);

create trigger rewrite_requests_set_updated_at
before update on public.rewrite_requests
for each row execute function public.set_updated_at();

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
    or p_provider <> 'ebond'
    or nullif(btrim(p_model), '') is null
  then
    raise exception using errcode = '22023', message = 'INVALID_REWRITE_ARGUMENT';
  end if;

  -- The unique insert is the execution claim: concurrent callers block here and only one proceeds.
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

  -- Lock the existing claim so its state and quota snapshot cannot change while it is returned.
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

create or replace function public.complete_rewrite_request(
  p_user_id uuid,
  p_request_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_microusd bigint
)
returns table (
  request_id uuid,
  request_state text,
  remaining_characters bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.rewrite_requests%rowtype;
  v_quota record;
  v_remaining_characters bigint;
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'REWRITE_ARGUMENT_REQUIRED';
  end if;

  if p_input_tokens < 0 or p_output_tokens < 0 or p_cost_microusd < 0 then
    raise exception using errcode = '22023', message = 'INVALID_USAGE_METRICS';
  end if;

  -- Serialize settlement with failure handling; the nested quota RPC keeps both changes atomic.
  select rr.*
  into v_existing
  from public.rewrite_requests as rr
  where rr.user_id = p_user_id and rr.request_id = p_request_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'REWRITE_REQUEST_NOT_FOUND';
  end if;

  if v_existing.status = 'failed' then
    raise exception using errcode = 'P0001', message = 'REWRITE_REQUEST_ALREADY_FAILED';
  end if;

  if v_existing.status = 'succeeded' then
    if v_existing.input_tokens <> p_input_tokens
      or v_existing.output_tokens <> p_output_tokens
      or v_existing.cost_microusd <> p_cost_microusd
    then
      raise exception using errcode = 'P0001', message = 'SETTLEMENT_CONFLICT';
    end if;

    select
      up.base_allowance + up.adjustment_characters
        - up.reserved_characters - up.consumed_characters
    into strict v_remaining_characters
    from public.usage_periods as up
    where up.id = v_existing.usage_period_id;

    return query select p_request_id, 'succeeded'::text, v_remaining_characters;
    return;
  end if;

  select *
  into strict v_quota
  from public.settle_quota(
    p_user_id,
    p_request_id,
    p_input_tokens,
    p_output_tokens,
    p_cost_microusd
  );

  update public.rewrite_requests as rr
  set
    status = 'succeeded',
    input_tokens = p_input_tokens,
    output_tokens = p_output_tokens,
    cost_microusd = p_cost_microusd,
    completed_at = now()
  where rr.user_id = p_user_id and rr.request_id = p_request_id;

  return query select p_request_id, 'succeeded'::text, v_quota.remaining_characters;
end;
$$;

create or replace function public.fail_rewrite_request(
  p_user_id uuid,
  p_request_id uuid,
  p_error_code text
)
returns table (
  request_id uuid,
  request_state text,
  remaining_characters bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.rewrite_requests%rowtype;
  v_quota record;
  v_remaining_characters bigint;
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'REWRITE_ARGUMENT_REQUIRED';
  end if;

  if p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'INVALID_ERROR_CODE';
  end if;

  -- Serialize release with settlement so a request can never be both charged and released.
  select rr.*
  into v_existing
  from public.rewrite_requests as rr
  where rr.user_id = p_user_id and rr.request_id = p_request_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'REWRITE_REQUEST_NOT_FOUND';
  end if;

  if v_existing.status = 'succeeded' then
    raise exception using errcode = 'P0001', message = 'REWRITE_REQUEST_ALREADY_SUCCEEDED';
  end if;

  if v_existing.status = 'failed' then
    if v_existing.sanitized_error_code <> p_error_code then
      raise exception using errcode = 'P0001', message = 'FAILURE_CONFLICT';
    end if;

    select
      up.base_allowance + up.adjustment_characters
        - up.reserved_characters - up.consumed_characters
    into strict v_remaining_characters
    from public.usage_periods as up
    where up.id = v_existing.usage_period_id;

    return query select p_request_id, 'failed'::text, v_remaining_characters;
    return;
  end if;

  select *
  into strict v_quota
  from public.release_quota(p_user_id, p_request_id);

  update public.rewrite_requests as rr
  set
    status = 'failed',
    sanitized_error_code = p_error_code,
    completed_at = now()
  where rr.user_id = p_user_id and rr.request_id = p_request_id;

  return query select p_request_id, 'failed'::text, v_quota.remaining_characters;
end;
$$;

alter table public.rewrite_requests enable row level security;

revoke all on table public.rewrite_requests from anon, authenticated;
grant select on table public.rewrite_requests to service_role;

revoke all on function public.begin_rewrite_request(uuid, uuid, text, bigint, text, text, text)
from public, anon, authenticated;
revoke all on function public.complete_rewrite_request(uuid, uuid, bigint, bigint, bigint)
from public, anon, authenticated;
revoke all on function public.fail_rewrite_request(uuid, uuid, text)
from public, anon, authenticated;

grant execute on function public.begin_rewrite_request(uuid, uuid, text, bigint, text, text, text)
to service_role;
grant execute on function public.complete_rewrite_request(uuid, uuid, bigint, bigint, bigint)
to service_role;
grant execute on function public.fail_rewrite_request(uuid, uuid, text)
to service_role;

commit;
