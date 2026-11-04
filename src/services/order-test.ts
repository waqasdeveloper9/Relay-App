import { reliability } from './reliability-settings.js';
import { config } from '../config.js';
import type { Store } from '../models/types.js';

// Explicit, expiring operator authorization for one merchant and one owned test number.
// This is never recorded as customer messaging consent.
export function orderTestAllowed(store: Store, recipient: string): boolean {
  const i = store.workspace.integration;
  const test = reliability(store.workspace).testMode;
  return (
    !config.demo &&
    !!test &&
    /^\d{10,15}$/.test(test.recipient) &&
    recipient === test.recipient &&
    Date.parse(test.until) > Date.now() &&
    !!i.whatsappVerifiedAt &&
    !!i.whatsappToken &&
    i.templateName === test.template &&
    /^[a-z0-9_]{1,100}$/.test(test.template) &&
    (i.templateName === 'hello_world'
      ? i.languageCode === 'en_US'
      : /^[a-z]{2}(?:_[A-Z]{2})?$/.test(i.languageCode))
  );
}
