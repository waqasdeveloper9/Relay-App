import type { Merchant, Workspace } from '../src/models/types';

export type PublicWorkspace = Omit<Workspace, 'integration' | 'processedEvents'> & {
  integration: Omit<
    Workspace['integration'],
    | 'shopifyToken'
    | 'whatsappToken'
    | 'shopifyRefreshToken'
    | 'metaAppSecret'
    | 'metaVerifyTokenHash'
  > & {
    hasShopifyToken: boolean;
    hasWhatsappToken: boolean;
    hasMetaAppSecret: boolean;
    hasMetaVerifyToken: boolean;
  };
};
export interface Snapshot {
  merchant: Omit<Merchant, 'passwordHash'>;
  workspace: PublicWorkspace;
  mode: 'demo' | 'connected';
  outboundEnabled: boolean;
  metaWebhookConfigured?: boolean;
  metaCallbackUrl?: string;
  orderTest?: { enabled: boolean; until?: string; template?: string };
}
export async function api<T = { ok: boolean; message?: string }>(
  url: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    credentials: 'same-origin',
    method: body === undefined ? 'GET' : method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value: T & { error?: string };
  try {
    value = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error('The server returned an unexpected response. Please try again.');
  }
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/auth/'))
      window.dispatchEvent(new Event('relay-session-expired'));
    const retryAfterSeconds = Number(response.headers.get('Retry-After'));
    throw Object.assign(new Error(value.error ?? 'Request failed'), {
      status: response.status,
      retryAfterSeconds:
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : undefined,
    });
  }
  return value;
}
