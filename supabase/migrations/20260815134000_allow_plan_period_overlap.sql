begin;

alter table public.usage_periods
drop constraint usage_periods_user_id_period_start_period_end_key;

alter table public.usage_periods
add constraint usage_periods_user_plan_period_key
unique (user_id, plan_code, period_start, period_end);

create or replace function public.handle_verified_sign_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
  v_period_start timestamptz := date_trunc('month', now());
  v_period_end timestamptz := date_trunc('month', now()) + interval '1 month';
  v_free_allowance bigint;
  v_user_metadata jsonb;
begin
  select u.raw_user_meta_data
  into strict v_user_metadata
  from auth.users as u
  where u.id = new.user_id;

  v_display_name := left(
    nullif(
      btrim(coalesce(v_user_metadata ->> 'full_name', v_user_metadata ->> 'name', '')),
      ''
    ),
    100
  );

  insert into public.profiles (id, display_name)
  values (new.user_id, v_display_name)
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id, plan_code, status)
  values (new.user_id, 'free', 'inactive')
  on conflict (user_id) do nothing;

  select p.monthly_character_limit
  into strict v_free_allowance
  from public.plans as p
  where p.code = 'free' and p.is_active;

  insert into public.usage_periods (
    user_id,
    plan_code,
    period_start,
    period_end,
    base_allowance
  )
  values (new.user_id, 'free', v_period_start, v_period_end, v_free_allowance)
  on conflict (user_id, plan_code, period_start, period_end) do nothing;

  return new;
end;
$$;

create or replace function public.reserve_quota(
  p_user_id uuid,
  p_request_id uuid,
  p_input_characters bigint
)
returns table (
  request_id uuid,
  usage_period_id uuid,
  reservation_state text,
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
  v_account_status text;
  v_subscription_plan text;
  v_subscription_status text;
  v_subscription_start timestamptz;
  v_subscription_end timestamptz;
  v_plan_code text;
  v_plan_allowance bigint;
  v_request_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_period_id uuid;
  v_base_allowance bigint;
  v_adjustment bigint;
  v_reserved bigint;
  v_consumed bigint;
  v_existing_period_id uuid;
  v_existing_characters bigint;
  v_existing_state text;
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'QUOTA_ARGUMENT_REQUIRED';
  end if;

  if p_input_characters <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_INPUT_CHARACTERS';
  end if;

  select p.status
  into v_account_status
  from public.profiles as p
  where p.id = p_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_NOT_INITIALIZED';
  end if;

  if v_account_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_SUSPENDED';
  end if;

  select
    s.plan_code,
    s.status,
    s.current_period_start,
    s.current_period_end
  into
    v_subscription_plan,
    v_subscription_status,
    v_subscription_start,
    v_subscription_end
  from public.subscriptions as s
  where s.user_id = p_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_NOT_INITIALIZED';
  end if;

  if v_subscription_plan = 'pro'
    and v_subscription_status in ('trialing', 'active')
    and v_subscription_start <= now()
    and v_subscription_end > now()
  then
    v_plan_code := 'pro';
    v_period_start := v_subscription_start;
    v_period_end := v_subscription_end;
  else
    v_plan_code := 'free';
    v_period_start := date_trunc('month', now());
    v_period_end := v_period_start + interval '1 month';
  end if;

  select p.monthly_character_limit, p.request_character_limit
  into strict v_plan_allowance, v_request_limit
  from public.plans as p
  where p.code = v_plan_code and p.is_active;

  if p_input_characters > v_request_limit then
    raise exception using errcode = 'P0001', message = 'REQUEST_LIMIT_EXCEEDED';
  end if;

  insert into public.usage_periods (
    user_id,
    plan_code,
    period_start,
    period_end,
    base_allowance
  )
  values (p_user_id, v_plan_code, v_period_start, v_period_end, v_plan_allowance)
  on conflict (user_id, plan_code, period_start, period_end) do nothing;

  select
    up.id,
    up.base_allowance,
    up.adjustment_characters,
    up.reserved_characters,
    up.consumed_characters
  into strict
    v_period_id,
    v_base_allowance,
    v_adjustment,
    v_reserved,
    v_consumed
  from public.usage_periods as up
  where up.user_id = p_user_id
    and up.plan_code = v_plan_code
    and up.period_start = v_period_start
    and up.period_end = v_period_end
  for update;

  select ul.period_id, ul.input_characters
  into v_existing_period_id, v_existing_characters
  from public.usage_ledger as ul
  where ul.user_id = p_user_id
    and ul.request_id = p_request_id
    and ul.entry_type = 'reserve';

  if found then
    if v_existing_period_id <> v_period_id or v_existing_characters <> p_input_characters then
      raise exception using errcode = 'P0001', message = 'REQUEST_ID_CONFLICT';
    end if;

    select case
      when exists (
        select 1 from public.usage_ledger as ul
        where ul.user_id = p_user_id
          and ul.request_id = p_request_id
          and ul.entry_type = 'settle'
      ) then 'settled'
      when exists (
        select 1 from public.usage_ledger as ul
        where ul.user_id = p_user_id
          and ul.request_id = p_request_id
          and ul.entry_type = 'release'
      ) then 'released'
      else 'reserved'
    end
    into v_existing_state;

    return query select
      p_request_id,
      v_period_id,
      v_existing_state,
      v_base_allowance + v_adjustment,
      v_reserved,
      v_consumed,
      v_base_allowance + v_adjustment - v_reserved - v_consumed;
    return;
  end if;

  if v_reserved + v_consumed + p_input_characters > v_base_allowance + v_adjustment then
    raise exception using errcode = 'P0001', message = 'QUOTA_EXCEEDED';
  end if;

  update public.usage_periods as up
  set reserved_characters = up.reserved_characters + p_input_characters
  where up.id = v_period_id
  returning up.reserved_characters into v_reserved;

  insert into public.usage_ledger (
    user_id,
    period_id,
    request_id,
    entry_type,
    input_characters
  )
  values (p_user_id, v_period_id, p_request_id, 'reserve', p_input_characters);

  return query select
    p_request_id,
    v_period_id,
    'reserved'::text,
    v_base_allowance + v_adjustment,
    v_reserved,
    v_consumed,
    v_base_allowance + v_adjustment - v_reserved - v_consumed;
end;
$$;

revoke all on function public.reserve_quota(uuid, uuid, bigint)
from public, anon, authenticated;
grant execute on function public.reserve_quota(uuid, uuid, bigint) to service_role;

commit;
