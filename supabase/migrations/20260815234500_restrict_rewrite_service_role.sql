begin;

-- Application writes must pass through the security-definer RPCs that enforce state transitions.
revoke all on table public.rewrite_requests from service_role;
grant select on table public.rewrite_requests to service_role;

commit;
