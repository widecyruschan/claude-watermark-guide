begin;

create table public.plans (
  code text primary key,
  display_name text not null,
  price_cents integer not null default 0 check (price_cents >= 0),
  billing_interval text not null default 'month' check (billing_interval = 'month'),
  monthly_character_limit bigint not null check (monthly_character_limit > 0),
  request_character_limit integer not null check (request_character_limit > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_code_format check (code ~ '^[a-z][a-z0-9_-]{1,31}$')
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 100),
  role text not null default 'member' check (role in ('member', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  plan_code text not null default 'free' references public.plans (code),
  status text not null default 'inactive'
    check (status in ('inactive', 'trialing', 'active', 'past_due', 'canceled')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_period_order check (
    current_period_start is null
    or current_period_end is null
    or current_period_end > current_period_start
  )
);

create table public.usage_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  plan_code text not null references public.plans (code),
  period_start timestamptz not null,
  period_end timestamptz not null,
  base_allowance bigint not null check (base_allowance > 0),
  adjustment_characters bigint not null default 0,
  reserved_characters bigint not null default 0 check (reserved_characters >= 0),
  consumed_characters bigint not null default 0 check (consumed_characters >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, period_start, period_end),
  constraint usage_periods_period_order check (period_end > period_start),
  constraint usage_periods_allowance_not_exceeded check (
    reserved_characters + consumed_characters <= base_allowance + adjustment_characters
  )
);

create index usage_periods_user_period_idx
  on public.usage_periods (user_id, period_start desc, period_end desc);

create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  period_id uuid not null references public.usage_periods (id) on delete cascade,
  request_id uuid not null,
  entry_type text not null check (entry_type in ('reserve', 'settle', 'release', 'adjustment')),
  input_characters bigint not null default 0 check (input_characters >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_microusd bigint not null default 0 check (cost_microusd >= 0),
  reason text,
  created_at timestamptz not null default now(),
  unique (user_id, request_id, entry_type),
  constraint usage_ledger_adjustment_reason check (
    entry_type <> 'adjustment' or nullif(btrim(reason), '') is not null
  )
);

create index usage_ledger_user_created_idx
  on public.usage_ledger (user_id, created_at desc);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_event_id text not null unique,
  event_type text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed')),
  payload_sha256 text,
  sanitized_error_code text,
  sanitized_error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  administrator_id uuid references auth.users (id) on delete set null,
  action text not null,
  target_user_id uuid references auth.users (id) on delete set null,
  reason text not null check (nullif(btrim(reason), '') is not null),
  request_id uuid not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.plans (
  code,
  display_name,
  price_cents,
  billing_interval,
  monthly_character_limit,
  request_character_limit,
  is_active
)
values
  ('free', 'Free', 0, 'month', 10000, 3000, true),
  ('pro', 'Pro', 900, 'month', 500000, 20000, true)
on conflict (code) do update
set
  display_name = excluded.display_name,
  price_cents = excluded.price_cents,
  billing_interval = excluded.billing_interval,
  monthly_character_limit = excluded.monthly_character_limit,
  request_character_limit = excluded.request_character_limit,
  is_active = excluded.is_active,
  updated_at = now();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger plans_set_updated_at
before update on public.plans
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger subscriptions_set_updated_at
before update on public.subscriptions
for each row execute function public.set_updated_at();

create trigger usage_periods_set_updated_at
before update on public.usage_periods
for each row execute function public.set_updated_at();

create trigger webhook_events_set_updated_at
before update on public.webhook_events
for each row execute function public.set_updated_at();

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
  on conflict (user_id, period_start, period_end) do nothing;

  return new;
end;
$$;

create trigger create_profile_after_verified_sign_in
after insert on auth.sessions
for each row execute function public.handle_verified_sign_in();

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
  on conflict (user_id, period_start, period_end) do nothing;

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

create or replace function public.settle_quota(
  p_user_id uuid,
  p_request_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_microusd bigint
)
returns table (
  request_id uuid,
  usage_period_id uuid,
  reservation_state text,
  reserved_characters bigint,
  consumed_characters bigint,
  remaining_characters bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_input_characters bigint;
  v_base_allowance bigint;
  v_adjustment bigint;
  v_reserved bigint;
  v_consumed bigint;
  v_existing_input_tokens bigint;
  v_existing_output_tokens bigint;
  v_existing_cost bigint;
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'QUOTA_ARGUMENT_REQUIRED';
  end if;

  if p_input_tokens < 0 or p_output_tokens < 0 or p_cost_microusd < 0 then
    raise exception using errcode = '22023', message = 'INVALID_USAGE_METRICS';
  end if;

  select ul.period_id, ul.input_characters
  into v_period_id, v_input_characters
  from public.usage_ledger as ul
  where ul.user_id = p_user_id
    and ul.request_id = p_request_id
    and ul.entry_type = 'reserve';

  if not found then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_FOUND';
  end if;

  select
    up.base_allowance,
    up.adjustment_characters,
    up.reserved_characters,
    up.consumed_characters
  into strict v_base_allowance, v_adjustment, v_reserved, v_consumed
  from public.usage_periods as up
  where up.id = v_period_id and up.user_id = p_user_id
  for update;

  select ul.input_tokens, ul.output_tokens, ul.cost_microusd
  into v_existing_input_tokens, v_existing_output_tokens, v_existing_cost
  from public.usage_ledger as ul
  where ul.user_id = p_user_id
    and ul.request_id = p_request_id
    and ul.entry_type = 'settle';

  if found then
    if v_existing_input_tokens <> p_input_tokens
      or v_existing_output_tokens <> p_output_tokens
      or v_existing_cost <> p_cost_microusd
    then
      raise exception using errcode = 'P0001', message = 'SETTLEMENT_CONFLICT';
    end if;

    return query select
      p_request_id,
      v_period_id,
      'settled'::text,
      v_reserved,
      v_consumed,
      v_base_allowance + v_adjustment - v_reserved - v_consumed;
    return;
  end if;

  if exists (
    select 1 from public.usage_ledger as ul
    where ul.user_id = p_user_id
      and ul.request_id = p_request_id
      and ul.entry_type = 'release'
  ) then
    raise exception using errcode = 'P0001', message = 'RESERVATION_ALREADY_RELEASED';
  end if;

  if v_reserved < v_input_characters then
    raise exception using errcode = 'P0001', message = 'QUOTA_INVARIANT_VIOLATION';
  end if;

  update public.usage_periods as up
  set
    reserved_characters = up.reserved_characters - v_input_characters,
    consumed_characters = up.consumed_characters + v_input_characters
  where up.id = v_period_id
  returning up.reserved_characters, up.consumed_characters
  into v_reserved, v_consumed;

  insert into public.usage_ledger (
    user_id,
    period_id,
    request_id,
    entry_type,
    input_characters,
    input_tokens,
    output_tokens,
    cost_microusd
  )
  values (
    p_user_id,
    v_period_id,
    p_request_id,
    'settle',
    v_input_characters,
    p_input_tokens,
    p_output_tokens,
    p_cost_microusd
  );

  return query select
    p_request_id,
    v_period_id,
    'settled'::text,
    v_reserved,
    v_consumed,
    v_base_allowance + v_adjustment - v_reserved - v_consumed;
end;
$$;

create or replace function public.release_quota(
  p_user_id uuid,
  p_request_id uuid
)
returns table (
  request_id uuid,
  usage_period_id uuid,
  reservation_state text,
  reserved_characters bigint,
  consumed_characters bigint,
  remaining_characters bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_input_characters bigint;
  v_base_allowance bigint;
  v_adjustment bigint;
  v_reserved bigint;
  v_consumed bigint;
begin
  if p_user_id is null or p_request_id is null then
    raise exception using errcode = '22004', message = 'QUOTA_ARGUMENT_REQUIRED';
  end if;

  select ul.period_id, ul.input_characters
  into v_period_id, v_input_characters
  from public.usage_ledger as ul
  where ul.user_id = p_user_id
    and ul.request_id = p_request_id
    and ul.entry_type = 'reserve';

  if not found then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_FOUND';
  end if;

  select
    up.base_allowance,
    up.adjustment_characters,
    up.reserved_characters,
    up.consumed_characters
  into strict v_base_allowance, v_adjustment, v_reserved, v_consumed
  from public.usage_periods as up
  where up.id = v_period_id and up.user_id = p_user_id
  for update;

  if exists (
    select 1 from public.usage_ledger as ul
    where ul.user_id = p_user_id
      and ul.request_id = p_request_id
      and ul.entry_type = 'settle'
  ) then
    return query select
      p_request_id,
      v_period_id,
      'settled'::text,
      v_reserved,
      v_consumed,
      v_base_allowance + v_adjustment - v_reserved - v_consumed;
    return;
  end if;

  if exists (
    select 1 from public.usage_ledger as ul
    where ul.user_id = p_user_id
      and ul.request_id = p_request_id
      and ul.entry_type = 'release'
  ) then
    return query select
      p_request_id,
      v_period_id,
      'released'::text,
      v_reserved,
      v_consumed,
      v_base_allowance + v_adjustment - v_reserved - v_consumed;
    return;
  end if;

  if v_reserved < v_input_characters then
    raise exception using errcode = 'P0001', message = 'QUOTA_INVARIANT_VIOLATION';
  end if;

  update public.usage_periods as up
  set reserved_characters = up.reserved_characters - v_input_characters
  where up.id = v_period_id
  returning up.reserved_characters into v_reserved;

  insert into public.usage_ledger (
    user_id,
    period_id,
    request_id,
    entry_type,
    input_characters
  )
  values (p_user_id, v_period_id, p_request_id, 'release', v_input_characters);

  return query select
    p_request_id,
    v_period_id,
    'released'::text,
    v_reserved,
    v_consumed,
    v_base_allowance + v_adjustment - v_reserved - v_consumed;
end;
$$;

create or replace function public.bootstrap_administrator(
  p_user_id uuid,
  p_reason text,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean := false;
begin
  if p_user_id is null or p_request_id is null or nullif(btrim(p_reason), '') is null then
    raise exception using errcode = '22023', message = 'ADMIN_BOOTSTRAP_ARGUMENT_REQUIRED';
  end if;

  if not exists (
    select 1
    from auth.users as u
    where u.id = p_user_id
      and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
  ) then
    raise exception using errcode = 'P0001', message = 'VERIFIED_USER_NOT_FOUND';
  end if;

  update public.profiles as p
  set role = 'admin'
  where p.id = p_user_id and p.role <> 'admin';
  v_changed := found;

  if v_changed then
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
      'administrator.bootstrap',
      p_user_id,
      p_reason,
      p_request_id,
      jsonb_build_object('actor', 'service_role')
    )
    on conflict (request_id) do nothing;
  end if;

  return v_changed;
end;
$$;

alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_periods enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.webhook_events enable row level security;
alter table public.admin_audit_logs enable row level security;

create policy plans_read_active
on public.plans
for select
to anon, authenticated
using (is_active);

create policy profiles_read_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy profiles_update_own
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy subscriptions_read_own
on public.subscriptions
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy usage_periods_read_own
on public.usage_periods
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy usage_ledger_read_own
on public.usage_ledger
for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.plans from anon, authenticated;
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.subscriptions from anon, authenticated;
revoke all on table public.usage_periods from anon, authenticated;
revoke all on table public.usage_ledger from anon, authenticated;
revoke all on table public.webhook_events from anon, authenticated;
revoke all on table public.admin_audit_logs from anon, authenticated;

grant select (
  code,
  display_name,
  price_cents,
  billing_interval,
  monthly_character_limit,
  request_character_limit,
  is_active
) on public.plans to anon, authenticated;

grant select (
  id,
  display_name,
  role,
  status,
  created_at,
  updated_at
) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select on public.subscriptions to authenticated;
grant select on public.usage_periods to authenticated;
grant select on public.usage_ledger to authenticated;

grant select, insert, update, delete on public.plans to service_role;
grant select, insert, update, delete on public.profiles to service_role;
grant select, insert, update, delete on public.subscriptions to service_role;
grant select, insert, update, delete on public.usage_periods to service_role;
grant select, insert on public.usage_ledger to service_role;
grant select, insert, update on public.webhook_events to service_role;
grant select, insert on public.admin_audit_logs to service_role;

revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.handle_verified_sign_in() from public, anon, authenticated, service_role;
revoke all on function public.reserve_quota(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.settle_quota(uuid, uuid, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.release_quota(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bootstrap_administrator(uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.reserve_quota(uuid, uuid, bigint) to service_role;
grant execute on function public.settle_quota(uuid, uuid, bigint, bigint, bigint) to service_role;
grant execute on function public.release_quota(uuid, uuid) to service_role;
grant execute on function public.bootstrap_administrator(uuid, text, uuid) to service_role;

commit;
