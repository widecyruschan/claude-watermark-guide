/// <reference lib="dom" />

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

interface OAuthCallbackClient {
  exchangeCodeForSession(code: string): Promise<{
    data: { session: unknown | null };
    error: { message?: string } | null;
  }>;
  getSession(): Promise<{
    data: { session: unknown | null };
    error: { message?: string } | null;
  }>;
}

export type OAuthCallbackResult =
  | { ok: true }
  | {
      message: string;
      ok: false;
    };

export interface PublicAuthConfig {
  supabasePublishableKey: string;
  supabaseUrl: string;
}

interface PublicAuthConfigResponse {
  data?: Partial<PublicAuthConfig>;
  success?: boolean;
}

export interface SubscriptionRecord {
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  current_period_start: string | null;
  grace_period_end: string | null;
  plan_code: string;
  status: string;
}

export interface BillingPresentation {
  canCheckout: boolean;
  canOpenPortal: boolean;
  message: string;
}

export function resolveEffectivePlan(
  subscription: SubscriptionRecord,
  now = new Date(),
): 'free' | 'pro' {
  const periodStart = subscription.current_period_start
    ? Date.parse(subscription.current_period_start)
    : Number.NaN;
  const periodEnd = subscription.current_period_end
    ? Date.parse(subscription.current_period_end)
    : Number.NaN;
  const gracePeriodEnd = subscription.grace_period_end
    ? Date.parse(subscription.grace_period_end)
    : Number.NaN;
  const isCurrentPro =
    subscription.plan_code === 'pro' &&
    Number.isFinite(periodStart) &&
    Number.isFinite(periodEnd) &&
    periodStart <= now.getTime() &&
    periodEnd > now.getTime() &&
    (subscription.status === 'active' ||
      subscription.status === 'trialing' ||
      (subscription.status === 'past_due' && gracePeriodEnd > now.getTime()));

  return isCurrentPro ? 'pro' : 'free';
}

export function resolveBillingPresentation(
  subscription: SubscriptionRecord,
  now = new Date(),
): BillingPresentation {
  if (subscription.status === 'incomplete') {
    return {
      canCheckout: false,
      canOpenPortal: false,
      message: 'Payment processing. Your plan will update after Stripe confirms payment.',
    };
  }

  if (subscription.status === 'past_due') {
    const gracePeriodEnd = subscription.grace_period_end;
    const graceEnd = Date.parse(gracePeriodEnd ?? '');
    const graceMessage =
      gracePeriodEnd && graceEnd > now.getTime()
        ? ` Pro access remains available through ${formatDate(gracePeriodEnd)}.`
        : ' Pro access is now limited to the Free plan.';
    return {
      canCheckout: false,
      canOpenPortal: true,
      message: `Payment failed.${graceMessage} Update your payment method to keep Pro.`,
    };
  }

  if (subscription.status === 'active' || subscription.status === 'trialing') {
    return {
      canCheckout: false,
      canOpenPortal: true,
      message: subscription.cancel_at_period_end
        ? 'Your Pro subscription will end after the current billing period.'
        : 'Your Pro subscription is active.',
    };
  }

  if (subscription.status === 'unpaid' || subscription.status === 'paused') {
    return {
      canCheckout: false,
      canOpenPortal: true,
      message: 'Pro access is paused. Open billing to resolve the payment issue.',
    };
  }

  return {
    canCheckout: true,
    canOpenPortal: false,
    message: 'Upgrade to Pro securely through Stripe Checkout.',
  };
}

export function shouldReturnToLogin(event: string, session: unknown | null): boolean {
  return event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && session === null);
}

export async function completeOAuthCallback(
  client: OAuthCallbackClient,
  callbackUrl: URL,
): Promise<OAuthCallbackResult> {
  if (callbackUrl.searchParams.has('error')) {
    return {
      ok: false,
      message: 'Sign-in was not completed. Please try again.',
    };
  }

  const code = callbackUrl.searchParams.get('code');

  if (code) {
    const { data, error } = await client.exchangeCodeForSession(code);

    if (!error && data.session) {
      return { ok: true };
    }
  }

  const { data, error } = await client.getSession();

  if (!error && data.session) {
    return { ok: true };
  }

  return {
    ok: false,
    message: 'We could not complete sign-in. Return to the sign-in page and try again.',
  };
}

export async function loadPublicAuthConfig(): Promise<PublicAuthConfig> {
  const response = await fetch('/api/v1/auth/config', {
    cache: 'no-store',
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  const body = (await response.json().catch(() => null)) as PublicAuthConfigResponse | null;
  const supabaseUrl = body?.data?.supabaseUrl;
  const supabasePublishableKey = body?.data?.supabasePublishableKey;

  if (
    !response.ok ||
    body?.success !== true ||
    typeof supabaseUrl !== 'string' ||
    !supabaseUrl.startsWith('https://') ||
    typeof supabasePublishableKey !== 'string' ||
    supabasePublishableKey.length < 20
  ) {
    throw new Error('AUTH_CONFIG_UNAVAILABLE');
  }

  return { supabasePublishableKey, supabaseUrl };
}

export function createBrowserClient(
  config: PublicAuthConfig,
  detectSessionInUrl = false,
): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl,
      flowType: 'pkce',
      persistSession: true,
    },
  });
}

export function resolvePostSignInPath(callbackUrl: URL): string {
  const next = callbackUrl.searchParams.get('next');

  if (next === '/rewrite' || next === '/account') {
    return next;
  }

  return '/account';
}

export function shouldStartReauthentication(url: URL): boolean {
  return url.searchParams.get('reauth') === '1';
}

type ElementConstructor<T extends HTMLElement> = new () => T;

function getElement<T extends HTMLElement>(id: string, elementType: ElementConstructor<T>): T {
  const element = document.getElementById(id);

  if (!(element instanceof elementType)) {
    throw new Error(`AUTH_ELEMENT_MISSING:${id}`);
  }

  return element;
}

function setStatus(message: string, isError = false): void {
  const status = getElement('authStatus', HTMLParagraphElement);
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function initializeLoginPage(client: SupabaseClient): Promise<void> {
  const loginUrl = new URL(window.location.href);
  const {
    data: { session },
  } = await client.auth.getSession();

  if (session && !shouldStartReauthentication(loginUrl)) {
    window.location.replace(resolvePostSignInPath(loginUrl));
    return;
  }

  if (session) {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) {
      setStatus('Authentication is temporarily unavailable. Please try again later.', true);
      return;
    }
  }

  const googleButton = getElement('googleSignInButton', HTMLButtonElement);
  const magicLinkForm = getElement('magicLinkForm', HTMLFormElement);
  const magicLinkEmail = getElement('magicLinkEmail', HTMLInputElement);
  const magicLinkButton = getElement('magicLinkButton', HTMLButtonElement);
  googleButton.disabled = false;
  magicLinkButton.disabled = false;
  setStatus(
    shouldStartReauthentication(loginUrl)
      ? 'Sign in again to verify account deletion.'
      : 'Ready to sign in.',
  );

  googleButton.addEventListener('click', () => {
    void startGoogleSignIn(client, googleButton);
  });
  magicLinkForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMagicLink(client, magicLinkEmail, magicLinkButton);
  });
}

async function sendMagicLink(
  client: SupabaseClient,
  emailInput: HTMLInputElement,
  magicLinkButton: HTMLButtonElement,
): Promise<void> {
  if (!emailInput.reportValidity()) {
    return;
  }

  magicLinkButton.disabled = true;
  setStatus('Sending your secure sign-in link…');
  const { error } = await client.auth.signInWithOtp({
    email: emailInput.value.trim(),
    options: {
      emailRedirectTo: getAuthCallbackUrl(),
      shouldCreateUser: true,
    },
  });

  if (error) {
    magicLinkButton.disabled = false;
    setStatus('We could not send the link. Check the email address and try again.', true);
    return;
  }

  setStatus('Check your email for a sign-in link. This page can stay open.');
}

async function startGoogleSignIn(
  client: SupabaseClient,
  googleButton: HTMLButtonElement,
): Promise<void> {
  googleButton.disabled = true;
  setStatus('Redirecting to Google…');

  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: getAuthCallbackUrl(),
    },
  });

  if (error) {
    googleButton.disabled = false;
    setStatus('Google sign-in is temporarily unavailable. Please try again.', true);
  }
}

async function initializeCallbackPage(client: SupabaseClient): Promise<void> {
  const callbackUrl = new URL(window.location.href);
  const result = await completeOAuthCallback(client.auth, callbackUrl);

  if (!result.ok) {
    setStatus(result.message, true);
    getElement('authRecovery', HTMLParagraphElement).hidden = false;
    return;
  }

  history.replaceState({}, '', '/auth/callback');
  setStatus('Sign-in complete. Opening your account…');
  window.location.replace(resolvePostSignInPath(callbackUrl));
}

function getAuthCallbackUrl(): string {
  const next = new URL(window.location.href).searchParams.get('next');
  const callbackUrl = new URL('/auth/callback', window.location.origin);

  if (next === '/rewrite' || next === '/account') {
    callbackUrl.searchParams.set('next', next);
  }

  return callbackUrl.toString();
}

async function initializeAccountPage(client: SupabaseClient): Promise<void> {
  const {
    data: { session },
    error,
  } = await client.auth.getSession();

  if (error || !session) {
    window.location.replace('/login');
    return;
  }

  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, refreshedSession) => {
    if (shouldReturnToLogin(event, refreshedSession)) {
      window.location.replace('/login');
    }
  });
  window.addEventListener('pagehide', () => subscription.unsubscribe(), { once: true });

  await renderAccount(client, session);

  const checkoutButton = getElement('startCheckoutButton', HTMLButtonElement);
  checkoutButton.addEventListener('click', () => {
    void openBillingDestination(client, 'checkout', checkoutButton);
  });
  const portalButton = getElement('openBillingPortalButton', HTMLButtonElement);
  portalButton.addEventListener('click', () => {
    void openBillingDestination(client, 'portal', portalButton);
  });

  const accountMenu = getElement('accountMenu', HTMLDetailsElement);
  accountMenu.hidden = false;
  getElement('signInNavigationLink', HTMLAnchorElement).hidden = true;
  getElement('menuSignOutButton', HTMLButtonElement).addEventListener('click', () => {
    void signOut(client, getElement('signOutButton', HTMLButtonElement));
  });

  const signOutButton = getElement('signOutButton', HTMLButtonElement);
  signOutButton.disabled = false;
  signOutButton.addEventListener('click', () => {
    void signOut(client, signOutButton);
  });

  const deleteButton = getElement('startDeleteAccountButton', HTMLButtonElement);
  deleteButton.disabled = false;
  const confirmation = getElement('deleteAccountConfirmation', HTMLDivElement);
  getElement('cancelDeleteAccountButton', HTMLButtonElement).addEventListener('click', () => {
    confirmation.hidden = true;
    getElement('reauthenticationNotice', HTMLParagraphElement).hidden = true;
    getElement('reauthenticateLink', HTMLAnchorElement).hidden = true;
  });
  deleteButton.addEventListener('click', () => {
    confirmation.hidden = false;
    getElement('confirmDeleteAccountButton', HTMLButtonElement).focus();
  });
  getElement('confirmDeleteAccountButton', HTMLButtonElement).addEventListener('click', () => {
    void deleteAccount(client);
  });
}

async function renderAccount(client: SupabaseClient, session: Session): Promise<void> {
  const [profileResult, subscriptionResult] = await Promise.all([
    client.from('profiles').select('display_name,status').eq('id', session.user.id).maybeSingle(),
    client
      .from('subscriptions')
      .select(
        'plan_code,status,current_period_start,current_period_end,cancel_at_period_end,grace_period_end',
      )
      .eq('user_id', session.user.id)
      .maybeSingle(),
  ]);
  const subscription = subscriptionResult.data as SubscriptionRecord | null;
  const effectivePlan = subscription ? resolveEffectivePlan(subscription) : null;
  const billingPresentation = subscription ? resolveBillingPresentation(subscription) : null;
  const now = new Date();
  const usageResult = effectivePlan
    ? await client
        .from('usage_periods')
        .select(
          'base_allowance,adjustment_characters,reserved_characters,consumed_characters,period_start,period_end',
        )
        .eq('user_id', session.user.id)
        .eq('plan_code', effectivePlan)
        .lte('period_start', now.toISOString())
        .gt('period_end', now.toISOString())
        .order('period_end', { ascending: false })
        .limit(1)
        .maybeSingle()
    : null;

  const metadataName =
    typeof session.user.user_metadata.full_name === 'string'
      ? session.user.user_metadata.full_name
      : null;
  const displayName = profileResult.data?.display_name ?? metadataName ?? 'Not set';
  const usage = usageResult?.data;
  const allowance = usage ? Number(usage.base_allowance) + Number(usage.adjustment_characters) : 0;
  const consumed = usage ? Number(usage.consumed_characters) : 0;
  const reserved = usage ? Number(usage.reserved_characters) : 0;
  const remaining = Math.max(0, allowance - consumed - reserved);
  const planLabel = subscriptionResult.error
    ? 'Unavailable'
    : effectivePlan
      ? effectivePlan.toUpperCase()
      : 'Pending';
  const billingStatus = subscriptionResult.error
    ? 'Unavailable'
    : subscription
      ? formatLabel(subscription.status)
      : 'Pending';
  const periodLabel = usage
    ? `${formatDate(usage.period_start)} – ${formatDate(usage.period_end)}`
    : usageResult?.error
      ? 'Unavailable'
      : 'Being prepared';
  const usageLabel = usage
    ? `${consumed.toLocaleString()} used · ${remaining.toLocaleString()} remaining of ${allowance.toLocaleString()}`
    : usageResult?.error
      ? 'Unavailable'
      : 'Usage period is being prepared';

  getElement('accountEmail', HTMLElement).textContent = session.user.email ?? 'Not available';
  getElement('accountDisplayName', HTMLElement).textContent = displayName;
  getElement('accountPlan', HTMLElement).textContent = planLabel;
  getElement('accountBillingStatus', HTMLElement).textContent = billingStatus;
  getElement('accountPeriod', HTMLElement).textContent = periodLabel;
  getElement('accountUsage', HTMLElement).textContent = usageLabel;
  const usageProgress = getElement('accountUsageProgress', HTMLProgressElement);
  usageProgress.value = allowance > 0 ? Math.min(1, (consumed + reserved) / allowance) : 0;
  usageProgress.setAttribute('aria-label', `${usageLabel}`);
  getElement('accountDetails', HTMLDListElement).hidden = false;
  getElement('accountUpgradeNotice', HTMLElement).hidden = effectivePlan === 'pro';
  const checkoutButton = getElement('startCheckoutButton', HTMLButtonElement);
  checkoutButton.hidden = !billingPresentation?.canCheckout;
  checkoutButton.disabled = !billingPresentation?.canCheckout;
  const portalButton = getElement('openBillingPortalButton', HTMLButtonElement);
  portalButton.hidden = !billingPresentation?.canOpenPortal;
  portalButton.disabled = !billingPresentation?.canOpenPortal;
  getElement('billingActionMessage', HTMLParagraphElement).textContent =
    billingPresentation?.message ?? 'Billing details are being prepared.';
  getElement('billingActions', HTMLElement).hidden = false;
  setStatus(
    profileResult.error || subscriptionResult.error || usageResult?.error
      ? 'Signed in. Some membership details are temporarily unavailable.'
      : 'Signed in.',
  );
}

async function openBillingDestination(
  client: SupabaseClient,
  destination: 'checkout' | 'portal',
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  const status = getElement('billingActionStatus', HTMLParagraphElement);
  status.textContent = destination === 'checkout' ? 'Opening secure checkout…' : 'Opening billing…';
  status.classList.remove('error');
  try {
    const {
      data: { session },
    } = await client.auth.getSession();

    if (!session) {
      window.location.replace('/login?next=/account');
      return;
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    };
    if (destination === 'checkout') {
      headers['idempotency-key'] = crypto.randomUUID();
    }

    const response = await fetch(`/api/v1/billing/${destination}`, {
      body: '{}',
      headers,
      method: 'POST',
    });
    const body = (await response.json().catch(() => null)) as {
      data?: { url?: string };
      message?: string;
      success?: boolean;
    } | null;

    if (!response.ok || body?.success !== true || typeof body.data?.url !== 'string') {
      button.disabled = false;
      status.textContent = body?.message ?? 'Billing is temporarily unavailable. Please try again.';
      status.classList.add('error');
      return;
    }

    const target = new URL(body.data.url);
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.stripe.com')) {
      throw new Error('INVALID_BILLING_DESTINATION');
    }

    window.location.assign(target.toString());
  } catch {
    button.disabled = false;
    status.textContent = 'Billing is temporarily unavailable. Please try again.';
    status.classList.add('error');
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatLabel(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function signOut(client: SupabaseClient, signOutButton: HTMLButtonElement): Promise<void> {
  signOutButton.disabled = true;
  setStatus('Signing out…');

  const { error } = await client.auth.signOut({ scope: 'local' });

  if (error) {
    signOutButton.disabled = false;
    setStatus('Sign-out failed. Please try again.', true);
    return;
  }

  window.location.replace('/login');
}

async function deleteAccount(client: SupabaseClient): Promise<void> {
  const deleteButton = getElement('confirmDeleteAccountButton', HTMLButtonElement);
  deleteButton.disabled = true;
  setStatus('Deleting your account…');

  const {
    data: { session },
  } = await client.auth.getSession();

  if (!session) {
    window.location.replace('/login');
    return;
  }

  const response = await fetch('/api/v1/account/delete', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.access_token}` },
  });

  if (!response.ok) {
    deleteButton.disabled = false;
    if (response.status === 409) {
      setStatus('Please sign in again before deleting your account.', true);
      getElement('reauthenticationNotice', HTMLParagraphElement).hidden = false;
      getElement('reauthenticateLink', HTMLAnchorElement).hidden = false;
    } else {
      setStatus('Account deletion is temporarily unavailable. Please try again later.', true);
    }
    return;
  }

  await client.auth.signOut({ scope: 'local' });
  window.location.replace('/');
}

async function initializeAuthPage(): Promise<void> {
  const page = document.body.dataset.authPage;

  if (page !== 'login' && page !== 'callback' && page !== 'account') {
    return;
  }

  try {
    const config = await loadPublicAuthConfig();
    const client = createBrowserClient(config, page === 'callback');

    if (page === 'login') {
      await initializeLoginPage(client);
    } else if (page === 'callback') {
      await initializeCallbackPage(client);
    } else {
      await initializeAccountPage(client);
    }
  } catch {
    setStatus('Authentication is temporarily unavailable. Please try again later.', true);

    if (page === 'callback') {
      getElement('authRecovery', HTMLParagraphElement).hidden = false;
    }
  }
}

if (typeof document !== 'undefined') {
  void initializeAuthPage();
}
