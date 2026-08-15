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
