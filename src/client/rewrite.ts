/// <reference lib="dom" />

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

import type { PublicAuthConfig } from './auth';

type RewriteOptions = {
  formality: 'low' | 'medium' | 'high';
  strength: 'low' | 'medium' | 'high';
  tone: 'neutral' | 'professional' | 'friendly' | 'concise';
};

const DEFAULT_OPTIONS: RewriteOptions = {
  formality: 'medium',
  strength: 'medium',
  tone: 'neutral',
};
const FREE_REQUEST_LIMIT = 3_000;
const PRO_REQUEST_LIMIT = 20_000;
const DRAFT_STORAGE_KEY = 'watermarklens:rewrite-draft:v1';

interface AuthConfigResponse {
  data?: Partial<PublicAuthConfig>;
  success?: boolean;
}

interface RewriteResponse {
  data?: {
    text?: string;
    usage?: {
      chargedCharacters?: number;
      remainingCharacters?: number;
    };
  };
  error?: { code?: string };
  message?: string;
  success?: boolean;
}

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const target = document.getElementById(id);
  if (!(target instanceof type)) {
    throw new Error(`REWRITE_ELEMENT_MISSING:${id}`);
  }
  return target;
}

function selectElement(id: string): HTMLSelectElement {
  const target = document.getElementById(id);
  if (!(target instanceof HTMLSelectElement)) {
    throw new Error(`REWRITE_ELEMENT_MISSING:${id}`);
  }
  return target;
}

function setStatus(message: string, isError = false): void {
  const status = element('rewriteStatus', HTMLElement);
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function createBrowserClient(config: PublicAuthConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: true,
    },
  });
}

async function loadConfig(): Promise<PublicAuthConfig> {
  const response = await fetch('/api/v1/auth/config', { cache: 'no-store' });
  const body = (await response.json().catch(() => null)) as AuthConfigResponse | null;
  const supabaseUrl = body?.data?.supabaseUrl;
  const supabasePublishableKey = body?.data?.supabasePublishableKey;

  if (
    !response.ok ||
    body?.success !== true ||
    typeof supabaseUrl !== 'string' ||
    !supabaseUrl.startsWith('https://') ||
    typeof supabasePublishableKey !== 'string'
  ) {
    throw new Error('AUTH_CONFIG_UNAVAILABLE');
  }

  return { supabasePublishableKey, supabaseUrl };
}

function loadDraft(): { options: RewriteOptions; text: string } | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ options: RewriteOptions; text: string }>;
    if (typeof parsed.text !== 'string' || !parsed.options) return null;
    return { options: { ...DEFAULT_OPTIONS, ...parsed.options }, text: parsed.text };
  } catch {
    return null;
  }
}

function saveDraft(text: string, options: RewriteOptions): void {
  try {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ options, text }));
  } catch {
    // Draft persistence is a convenience; the live textarea remains authoritative.
  }
}

function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Ignore storage restrictions without losing the completed result.
  }
}

function getOptions(): RewriteOptions {
  return {
    formality: selectElement('rewriteFormality').value as RewriteOptions['formality'],
    strength: selectElement('rewriteStrength').value as RewriteOptions['strength'],
    tone: selectElement('rewriteTone').value as RewriteOptions['tone'],
  };
}

function setOptions(options: RewriteOptions): void {
  selectElement('rewriteFormality').value = options.formality;
  selectElement('rewriteStrength').value = options.strength;
  selectElement('rewriteTone').value = options.tone;
}

function updateCharacterCount(limit: number): void {
  const input = element('rewriteInput', HTMLTextAreaElement);
  const count = [...input.value].length;
  const counter = element('rewriteCharacterCount', HTMLElement);
  counter.textContent = `${count.toLocaleString()} / ${limit.toLocaleString()} characters`;
  counter.classList.toggle('error', count > limit);
}

function getCurrentRequestLimit(): number {
  const requestedLimit = Number(element('rewriteInput', HTMLTextAreaElement).dataset.requestLimit);
  return Number.isFinite(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : FREE_REQUEST_LIMIT;
}

function setAuthenticatedControls(isAuthenticated: boolean, limit: number): void {
  const input = element('rewriteInput', HTMLTextAreaElement);
  const submit = element('rewriteSubmitButton', HTMLButtonElement);
  const tone = selectElement('rewriteTone');
  const formality = selectElement('rewriteFormality');
  const strength = selectElement('rewriteStrength');
  const notice = element('rewriteAuthNotice', HTMLElement);
  const signInLink = element('rewriteSignInLink', HTMLAnchorElement);

  input.dataset.requestLimit = String(limit);
  notice.hidden = isAuthenticated;
  signInLink.hidden = isAuthenticated;
  submit.disabled = !isAuthenticated;
  input.disabled = false;
  tone.disabled = !isAuthenticated;
  formality.disabled = !isAuthenticated;
  strength.disabled = !isAuthenticated;
  element('rewriteLimitHint', HTMLElement).textContent = isAuthenticated
    ? `Your current plan allows up to ${limit.toLocaleString()} characters per request.`
    : 'Sign in to use AI rewriting. Your local draft will remain on this device.';
  updateCharacterCount(limit);
}

export function resolveRewriteFailure(
  status: number,
  errorCode: string | undefined,
): { disableSubmission: boolean; showUpgrade: boolean; status: string } {
  if (status === 401) {
    return {
      disableSubmission: true,
      showUpgrade: false,
      status: 'Your session expired. Sign in again to retry; your draft is still here.',
    };
  }

  if (status === 413 || status === 422 || errorCode === 'QUOTA_EXCEEDED') {
    return {
      disableSubmission: false,
      showUpgrade: true,
      status: 'This rewrite cannot be completed with your current request or allowance limit.',
    };
  }

  return {
    disableSubmission: false,
    showUpgrade: false,
    status: 'The rewrite could not be completed. Please try again.',
  };
}

async function loadRequestLimit(client: SupabaseClient, session: Session): Promise<number> {
  const [subscriptionResult, usageResult] = await Promise.all([
    client
      .from('subscriptions')
      .select('plan_code,status,current_period_start,current_period_end,grace_period_end')
      .eq('user_id', session.user.id)
      .maybeSingle(),
    client.from('plans').select('code,request_character_limit').eq('is_active', true),
  ]);
  const subscription = subscriptionResult.data;
  const now = Date.now();
  const isPro =
    subscription?.plan_code === 'pro' &&
    Number.isFinite(Date.parse(subscription.current_period_start ?? '')) &&
    Number.isFinite(Date.parse(subscription.current_period_end ?? '')) &&
    Date.parse(subscription.current_period_start ?? '') <= now &&
    Date.parse(subscription.current_period_end ?? '') > now &&
    (subscription.status === 'active' ||
      subscription.status === 'trialing' ||
      (subscription.status === 'past_due' &&
        Date.parse(subscription.grace_period_end ?? '') > now));
  const plan = usageResult.data?.find((item) => item.code === (isPro ? 'pro' : 'free'));
  return Number(plan?.request_character_limit) || (isPro ? PRO_REQUEST_LIMIT : FREE_REQUEST_LIMIT);
}

async function submitRewrite(client: SupabaseClient, session: Session): Promise<void> {
  const input = element('rewriteInput', HTMLTextAreaElement);
  const submit = element('rewriteSubmitButton', HTMLButtonElement);
  const cancel = element('rewriteCancelButton', HTMLButtonElement);
  const options = getOptions();
  const text = input.value.trim();
  const limit = getCurrentRequestLimit();

  if (!text) {
    setStatus('Paste or enter text before starting a rewrite.', true);
    input.focus();
    return;
  }
  if ([...text].length > limit) {
    element('rewriteUpgradeNotice', HTMLElement).hidden = false;
    setStatus(`This request is over the ${limit.toLocaleString()} character limit.`, true);
    return;
  }

  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  let canRetry = true;
  submit.disabled = true;
  cancel.disabled = false;
  setStatus('Rewriting… You can cancel while the request is in progress.');
  saveDraft(input.value, options);
  cancel.onclick = () => controller.abort();

  try {
    const response = await fetch('/api/v1/rewrite', {
      body: JSON.stringify({ options, text }),
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
      method: 'POST',
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as RewriteResponse | null;

    if (!response.ok || body?.success !== true || typeof body.data?.text !== 'string') {
      const failure = resolveRewriteFailure(response.status, body?.error?.code);
      if (response.status === 401) {
        canRetry = !failure.disableSubmission;
        setStatus(failure.status, true);
        element('rewriteAuthNoticeText', HTMLElement).textContent =
          'Your session expired. Sign in again to continue.';
        element('rewriteAuthNotice', HTMLElement).hidden = false;
        submit.disabled = true;
        return;
      }
      if (failure.showUpgrade) {
        element('rewriteUpgradeNotice', HTMLElement).hidden = false;
      }
      setStatus(body?.message ?? failure.status, true);
      return;
    }

    element('rewriteResult', HTMLTextAreaElement).value = body.data.text;
    element('rewriteResultPanel', HTMLElement).hidden = false;
    element('rewriteUsageSummary', HTMLElement).textContent =
      body.data.usage?.remainingCharacters != null
        ? `${body.data.usage.remainingCharacters.toLocaleString()} characters remaining`
        : '';
    element('rewriteUpgradeNotice', HTMLElement).hidden = true;
    setStatus('Rewrite complete.');
    clearDraft();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('Rewrite cancelled. Your draft is still here.');
    } else {
      setStatus('Network error. Your draft is still here; please retry.', true);
    }
  } finally {
    submit.disabled = !canRetry;
    cancel.disabled = true;
  }
}

function attachResultActions(): void {
  element('copyRewriteResultButton', HTMLButtonElement).addEventListener('click', async () => {
    const result = element('rewriteResult', HTMLTextAreaElement).value;
    try {
      await navigator.clipboard.writeText(result);
      setStatus('Result copied to your clipboard.');
    } catch {
      const resultInput = element('rewriteResult', HTMLTextAreaElement);
      resultInput.focus();
      resultInput.select();
      setStatus('Select the result and copy it from your browser.', true);
    }
  });
  element('downloadRewriteResultButton', HTMLButtonElement).addEventListener('click', () => {
    const result = element('rewriteResult', HTMLTextAreaElement).value;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([result], { type: 'text/plain;charset=utf-8' }));
    link.download = 'watermark-lens-rewrite.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

async function initializeRewritePage(): Promise<void> {
  const input = element('rewriteInput', HTMLTextAreaElement);
  const draft = loadDraft();
  if (draft) {
    input.value = draft.text;
    setOptions(draft.options);
  }
  input.addEventListener('input', () => {
    updateCharacterCount(getCurrentRequestLimit());
    saveDraft(input.value, getOptions());
  });
  for (const controlId of ['rewriteTone', 'rewriteFormality', 'rewriteStrength']) {
    selectElement(controlId).addEventListener('change', () => {
      saveDraft(input.value, getOptions());
    });
  }
  attachResultActions();

  try {
    const client = createBrowserClient(await loadConfig());
    const sessionResult = await client.auth.getSession();
    let session = sessionResult.data.session;
    const applySession = async (nextSession: Session | null): Promise<void> => {
      session = nextSession;
      if (!nextSession) {
        setAuthenticatedControls(false, FREE_REQUEST_LIMIT);
        element('signInNavigationLink', HTMLAnchorElement).hidden = false;
        element('rewriteAuthNoticeText', HTMLElement).textContent =
          'Sign in to use AI rewriting. Your local draft will remain here.';
        return;
      }
      const limit = await loadRequestLimit(client, nextSession).catch(() => FREE_REQUEST_LIMIT);
      setAuthenticatedControls(true, limit);
      element('signInNavigationLink', HTMLAnchorElement).hidden = true;
      element('accountMenu', HTMLDetailsElement).hidden = false;
    };
    await applySession(session);
    client.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'TOKEN_REFRESHED' && nextSession) {
        session = nextSession;
        return;
      }
      if (event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && !nextSession)) {
        void applySession(null);
        setStatus('Your session expired. Sign in again to retry; your draft is still here.', true);
      }
    });
    element('rewriteForm', HTMLFormElement).addEventListener('submit', (event) => {
      event.preventDefault();
      if (session) void submitRewrite(client, session);
      else setStatus('Sign in before starting an AI rewrite.', true);
    });
    element('menuSignOutButton', HTMLButtonElement).addEventListener('click', () => {
      void client.auth.signOut({ scope: 'local' });
    });
  } catch {
    setAuthenticatedControls(false, FREE_REQUEST_LIMIT);
    element('rewriteAuthNoticeText', HTMLElement).textContent =
      'Authentication is temporarily unavailable. Your draft remains on this device.';
    setStatus(
      'Authentication is temporarily unavailable. Your draft remains on this device.',
      true,
    );
  }
}

if (typeof document !== 'undefined') {
  void initializeRewritePage();
}
