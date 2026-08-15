import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const administratorEmail = process.env.SUPABASE_ADMIN_EMAIL?.trim().toLowerCase();
const bootstrapReason =
  process.env.SUPABASE_ADMIN_REASON?.trim() || 'Initial administrator bootstrap';

if (!supabaseUrl || !serviceRoleKey || !administratorEmail) {
  throw new Error(
    'SUPABASE_URL, SUPABASE_ADMIN_EMAIL and a Supabase service-role or secret key are required.',
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

let matchedUser;

for (let page = 1; !matchedUser; page += 1) {
  const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });

  if (error) {
    throw new Error(`Unable to list Supabase users: ${error.message}`);
  }

  matchedUser = data.users.find((user) => user.email?.toLowerCase() === administratorEmail);

  if (data.users.length < 1000) {
    break;
  }
}

if (!matchedUser) {
  throw new Error('Administrator email does not match an existing Supabase Auth user.');
}

if (!matchedUser.email_confirmed_at) {
  throw new Error('Administrator account must complete a verified sign-in first.');
}

const { data: roleChanged, error: bootstrapError } = await supabase.rpc('bootstrap_administrator', {
  p_reason: bootstrapReason,
  p_request_id: randomUUID(),
  p_user_id: matchedUser.id,
});

if (bootstrapError) {
  throw new Error(`Unable to bootstrap administrator: ${bootstrapError.message}`);
}

console.log(
  roleChanged
    ? `Administrator access granted to ${administratorEmail}.`
    : `${administratorEmail} is already an administrator.`,
);
