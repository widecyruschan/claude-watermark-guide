begin;

revoke insert, update on public.plans from service_role;
revoke insert, update on public.profiles from service_role;
revoke insert, update on public.usage_periods from service_role;
revoke insert on public.usage_ledger from service_role;

commit;
