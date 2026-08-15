begin;

revoke delete on public.plans from service_role;
revoke delete on public.profiles from service_role;
revoke delete on public.subscriptions from service_role;
revoke delete on public.usage_periods from service_role;

commit;
