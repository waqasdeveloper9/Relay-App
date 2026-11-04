import { ProviderError } from './providers.js';
export const maxJobAttempts = 8;
export function retryDelay(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds) return Math.min(3600000, retryAfterSeconds * 1000);
  const ceiling = Math.min(3600000, 30000 * 2 ** Math.min(Math.max(attempt - 1, 0), 7));
  return Math.floor(ceiling * (0.75 + Math.random() * 0.25));
}
export function jobRetry(
  kind: string,
  error: unknown,
  attempts: number,
): { retry: boolean; unknown: boolean; delay: number } {
  const ambiguous = error instanceof ProviderError && error.ambiguous;
  const tagAction = ['TAG', 'CANCEL_TAGS', 'CANCEL_CLEANUP'].includes(kind);
  const safe = tagAction || !ambiguous;
  return {
    retry:
      safe &&
      error instanceof ProviderError &&
      (!!error.details.retryable || (tagAction && ambiguous)) &&
      attempts < maxJobAttempts,
    unknown: ambiguous && !tagAction,
    delay: retryDelay(
      attempts,
      error instanceof ProviderError ? error.details.retryAfterSeconds : undefined,
    ),
  };
}
