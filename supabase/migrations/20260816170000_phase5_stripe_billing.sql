begin;

alter table public.subscriptions
drop constraint subscriptions_status_check;

alter table public.subscriptions
add constraint subscriptions_status_check check (
  status in (
    'inactive',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'paused',
    'canceled'
  )
);

alter table public.subscriptions
add column stripe_price_id text,
add column stripe_checkout_session_id text unique,
add column grace_period_end timestamptz,
add column last_stripe_event_created_at timestamptz,
add column last_stripe_checkout_event_created_at timestamptz,
add column last_stripe_subscription_event_created_at timestamptz,
add column last_stripe_invoice_event_created_at timestamptz;

alter table public.subscriptions
add constraint subscriptions_grace_shape check (
  grace_period_end is null or status = 'past_due'
);

create or replace function public.begin_stripe_checkout(
  p_user_id uuid,
  p_checkout_session_id text,
  p_price_id text,
  p_customer_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_status text;
  v_subscription public.subscriptions%rowtype;
begin
  if p_user_id is null
    or p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    or p_price_id !~ '^price_[A-Za-z0-9_]+$'
    or (p_customer_id is not null and p_customer_id !~ '^cus_[A-Za-z0-9_]+$')
  then
    raise exception using errcode = '22023', message = 'INVALID_CHECKOUT_ARGUMENT';
  end if;

  select p.status
  into v_profile_status
  from public.profiles as p
  where p.id = p_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_NOT_INITIALIZED';
  end if;

  if v_profile_status <> 'active' then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_SUSPENDED';
  end if;

  select s.*
  into strict v_subscription
  from public.subscriptions as s
  where s.user_id = p_user_id
  for update;

  if v_subscription.status = 'incomplete' then
    if v_subscription.stripe_checkout_session_id = p_checkout_session_id then
      return;
    end if;

    raise exception using errcode = 'P0001', message = 'CHECKOUT_ALREADY_PENDING';
  end if;

  if v_subscription.status in ('trialing', 'active', 'past_due', 'unpaid', 'paused') then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_ALREADY_ACTIVE';
  end if;

  update public.subscriptions as s
  set
    plan_code = 'free',
    status = 'incomplete',
    stripe_customer_id = coalesce(p_customer_id, s.stripe_customer_id),
    stripe_subscription_id = null,
    stripe_price_id = p_price_id,
    stripe_checkout_session_id = p_checkout_session_id,
    current_period_start = null,
    current_period_end = null,
    cancel_at_period_end = false,
    grace_period_end = null,
    last_stripe_checkout_event_created_at = null,
    last_stripe_subscription_event_created_at = null,
    last_stripe_invoice_event_created_at = null
  where s.user_id = p_user_id;
end;
$$;

create or replace function public.process_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_payload_sha256 text,
  p_user_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_checkout_session_id text,
  p_price_id text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_grace_period_end timestamptz
)
returns table (event_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_inserted boolean := false;
  v_subscription public.subscriptions%rowtype;
  v_is_supported boolean;
  v_allowance bigint;
  v_checkout_pending boolean := false;
begin
  if p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    or nullif(btrim(p_event_type), '') is null
    or p_event_created_at is null
    or p_payload_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'INVALID_STRIPE_EVENT';
  end if;

  insert into public.webhook_events (
    provider_event_id,
    event_type,
    status,
    payload_sha256
  )
  values (p_event_id, p_event_type, 'processing', p_payload_sha256)
  on conflict (provider_event_id) do nothing
  returning true into v_event_inserted;

  if v_event_inserted is not true then
    return query select 'duplicate'::text;
    return;
  end if;

  v_is_supported := p_event_type in (
    'checkout.session.completed',
    'checkout.session.expired',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
    'invoice.paid'
  );

  if not v_is_supported then
    update public.webhook_events as we
    set status = 'processed', processed_at = now()
    where we.provider_event_id = p_event_id;

    return query select 'ignored'::text;
    return;
  end if;

  if p_event_type in ('checkout.session.completed', 'checkout.session.expired') then
    if p_checkout_session_id is null then
      raise exception using errcode = '22023', message = 'INVALID_CHECKOUT_EVENT';
    end if;

    select s.*
    into v_subscription
    from public.subscriptions as s
    where s.stripe_checkout_session_id = p_checkout_session_id
    for update;
  elsif p_event_type like 'customer.subscription.%' then
    if p_status not in (
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'paused',
      'canceled'
    ) or p_customer_id is null or p_subscription_id is null or p_price_id is null then
      raise exception using errcode = '22023', message = 'INVALID_SUBSCRIPTION_EVENT';
    end if;

    select s.*
    into v_subscription
    from public.subscriptions as s
    where s.stripe_subscription_id = p_subscription_id
    for update;

    if v_subscription.id is null and p_user_id is not null then
      select s.*
      into v_subscription
      from public.subscriptions as s
      where s.user_id = p_user_id
        and s.stripe_subscription_id is null
        and s.status <> 'incomplete'
      for update;

      if v_subscription.id is null then
        select exists (
          select 1
          from public.subscriptions as s
          where s.user_id = p_user_id
            and s.status = 'incomplete'
        )
        into v_checkout_pending;

        if v_checkout_pending then
          raise exception using errcode = 'P0001', message = 'CHECKOUT_NOT_READY';
        end if;
      end if;
    end if;
  else
    if p_subscription_id is null then
      raise exception using errcode = '22023', message = 'INVALID_INVOICE_EVENT';
    end if;

    select s.*
    into v_subscription
    from public.subscriptions as s
    where s.stripe_subscription_id = p_subscription_id
    for update;
  end if;

  if v_subscription.id is null then
    update public.webhook_events as we
    set status = 'processed', processed_at = now()
    where we.provider_event_id = p_event_id;

    return query select 'ignored'::text;
    return;
  end if;

  if p_event_type in ('checkout.session.completed', 'checkout.session.expired') then
    if v_subscription.last_stripe_checkout_event_created_at > p_event_created_at then
      update public.webhook_events as we
      set status = 'processed', processed_at = now()
      where we.provider_event_id = p_event_id;

      return query select 'stale'::text;
      return;
    end if;

    if p_event_type = 'checkout.session.expired' and v_subscription.status <> 'incomplete' then
      update public.webhook_events as we
      set status = 'processed', processed_at = now()
      where we.provider_event_id = p_event_id;

      return query select 'ignored'::text;
      return;
    end if;

    if p_event_type = 'checkout.session.completed'
      and v_subscription.stripe_subscription_id is not null
      and v_subscription.stripe_subscription_id <> p_subscription_id
    then
      update public.webhook_events as we
      set status = 'processed', processed_at = now()
      where we.provider_event_id = p_event_id;

      return query select 'ignored'::text;
      return;
    end if;

    update public.subscriptions as s
    set
      plan_code = case
        when p_event_type = 'checkout.session.expired' then 'free'
        else s.plan_code
      end,
      status = case
        when p_event_type = 'checkout.session.expired' then 'incomplete_expired'
        else s.status
      end,
      stripe_customer_id = coalesce(p_customer_id, s.stripe_customer_id),
      stripe_subscription_id = coalesce(p_subscription_id, s.stripe_subscription_id),
      last_stripe_event_created_at = greatest(
        s.last_stripe_event_created_at,
        p_event_created_at
      ),
      last_stripe_checkout_event_created_at = p_event_created_at
    where s.id = v_subscription.id;
  elsif p_event_type like 'customer.subscription.%' then
    if v_subscription.last_stripe_subscription_event_created_at > p_event_created_at then
      update public.webhook_events as we
      set status = 'processed', processed_at = now()
      where we.provider_event_id = p_event_id;

      return query select 'stale'::text;
      return;
    end if;

    update public.subscriptions as s
    set
      plan_code = 'pro',
      status = case
        when s.last_stripe_invoice_event_created_at > p_event_created_at then s.status
        else p_status
      end,
      stripe_customer_id = p_customer_id,
      stripe_subscription_id = p_subscription_id,
      stripe_price_id = p_price_id,
      current_period_start = p_period_start,
      current_period_end = p_period_end,
      cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
      grace_period_end = case
        when s.last_stripe_invoice_event_created_at > p_event_created_at
          then s.grace_period_end
        when p_status = 'past_due' and s.status = 'past_due'
          then coalesce(s.grace_period_end, p_grace_period_end, p_event_created_at + interval '3 days')
        when p_status = 'past_due'
          then coalesce(p_grace_period_end, p_event_created_at + interval '3 days')
        else null
      end,
      last_stripe_event_created_at = greatest(
        s.last_stripe_event_created_at,
        p_event_created_at
      ),
      last_stripe_subscription_event_created_at = p_event_created_at
    where s.id = v_subscription.id;

    if p_status in ('trialing', 'active', 'past_due')
      and p_period_start is not null
      and p_period_end is not null
      and p_period_end > p_period_start
    then
      select p.monthly_character_limit
      into strict v_allowance
      from public.plans as p
      where p.code = 'pro' and p.is_active;

      insert into public.usage_periods (
        user_id,
        plan_code,
        period_start,
        period_end,
        base_allowance
      )
      values (
        v_subscription.user_id,
        'pro',
        p_period_start,
        p_period_end,
        v_allowance
      )
      on conflict (user_id, plan_code, period_start, period_end) do nothing;
    end if;
  elsif p_event_type = 'invoice.payment_failed' then
    if v_subscription.last_stripe_invoice_event_created_at > p_event_created_at
      or v_subscription.last_stripe_subscription_event_created_at > p_event_created_at
    then
      update public.webhook_events as we
      set status = 'processed', processed_at = now()
      where we.provider_event_id = p_event_id;

      return query select 'stale'::text;
      return;
    end if;

    update public.subscriptions as s
    set
      status = case when s.status = 'canceled' then s.status else 'past_due' end,
      grace_period_end = case
        when s.status = 'canceled' then null
        when s.status = 'past_due'
          then coalesce(s.grace_period_end, p_grace_period_end, p_event_created_at + interval '3 days')
        else coalesce(p_grace_period_end, p_event_created_at + interval '3 days')
      end,
      last_stripe_event_created_at = greatest(
        s.last_stripe_event_created_at,
        p_event_created_at
      ),
      last_stripe_invoice_event_created_at = p_event_created_at
    where s.id = v_subscription.id;
  elsif p_event_type = 'invoice.paid' then
    if v_subscription.last_stripe_invoice_event_created_at > p_event_created_at
      or v_subscription.last_stripe_subscription_event_created_at > p_event_created_at
    then
      update public.webhook_events as we
      set status = 'processed', processed_at = now()
      where we.provider_event_id = p_event_id;

      return query select 'stale'::text;
      return;
    end if;

    update public.subscriptions as s
    set
      status = case when s.status = 'canceled' then s.status else 'active' end,
      grace_period_end = null,
      last_stripe_event_created_at = greatest(
        s.last_stripe_event_created_at,
        p_event_created_at
      ),
      last_stripe_invoice_event_created_at = p_event_created_at
    where s.id = v_subscription.id;
  end if;

  update public.webhook_events as we
  set status = 'processed', processed_at = now()
  where we.provider_event_id = p_event_id;

  return query select 'applied'::text;
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
  v_subscription_grace_end timestamptz;
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
    s.current_period_end,
    s.grace_period_end
  into
    v_subscription_plan,
    v_subscription_status,
    v_subscription_start,
    v_subscription_end,
    v_subscription_grace_end
  from public.subscriptions as s
  where s.user_id = p_user_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_NOT_INITIALIZED';
  end if;

  if v_subscription_plan = 'pro'
    and v_subscription_start <= now()
    and v_subscription_end > now()
    and (
      v_subscription_status in ('trialing', 'active')
      or (
        v_subscription_status = 'past_due'
        and v_subscription_grace_end > now()
      )
    )
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

revoke select on public.subscriptions from authenticated;
grant select (
  id,
  user_id,
  plan_code,
  status,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  grace_period_end,
  created_at,
  updated_at
) on public.subscriptions to authenticated;

revoke insert, update on public.subscriptions from service_role;
revoke insert, update on public.webhook_events from service_role;

revoke all on function public.begin_stripe_checkout(uuid, text, text, text)
from public, anon, authenticated;
revoke all on function public.process_stripe_webhook_event(
  text,
  text,
  timestamptz,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  boolean,
  timestamptz
)
from public, anon, authenticated;

grant execute on function public.begin_stripe_checkout(uuid, text, text, text) to service_role;
grant execute on function public.process_stripe_webhook_event(
  text,
  text,
  timestamptz,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  boolean,
  timestamptz
) to service_role;

commit;
