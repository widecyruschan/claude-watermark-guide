begin;

revoke select on public.subscriptions from authenticated;
grant select (
  id,
  user_id,
  plan_code,
  status,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  created_at,
  updated_at
) on public.subscriptions to authenticated;

revoke select on public.usage_ledger from authenticated;
grant select (
  id,
  user_id,
  period_id,
  request_id,
  entry_type,
  input_characters,
  created_at
) on public.usage_ledger to authenticated;

commit;
