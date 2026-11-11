import type {
  DispatchNotificationSettings,
  Integration,
  Order,
  QuickReply,
  ShopifySyncSettings,
  SupportSettings,
  Workspace,
} from './types.js';

export const defaultShopifySync: ShopifySyncSettings = {
  importNonCodOrders: true,
  codGatewayKeywords: ['cash on delivery', 'cod'],
  confirmedTag: 'COD-CONFIRMED',
  reviewTag: 'COD-REVIEW-NEEDED',
  cancellationRequestedTag: 'CANCELLATION-REQUESTED',
  tagOnReview: false,
  autoHoldUnconfirmed: false,
  holdOnReview: false,
  holdOnCancellationRequest: false,
  releaseHoldOnConfirm: true,
  holdReasonNotes: 'Awaiting Relay COD confirmation or merchant review',
  syncCustomerSmsConsent: true,
  checkoutConsentAttributeKey: 'whatsapp_opt_in',
  checkoutConsentValues: ['yes', 'true', '1', 'opt_in', 'subscribed'],
};

export const defaultDispatchNotifications: DispatchNotificationSettings = {
  enabled: false,
  templateName: '',
  languageCode: 'en',
  variables: ['customer_name', 'order_number', 'courier', 'tracking_number', 'tracking_url'],
  includeTrackingButtonUrl: false,
  notifyOnPartial: false,
  deliveredEnabled: false,
  deliveredTemplateName: '',
  deliveredLanguageCode: 'en',
  deliveredVariables: ['customer_name', 'order_number', 'brand_name'],
  paidEnabled: false,
  paidTemplateName: '',
  paidLanguageCode: 'en',
  paidVariables: ['customer_name', 'order_number', 'total_amount', 'brand_name'],
  inProgressEnabled: false,
  inProgressTemplateName: '',
  inProgressLanguageCode: 'en',
  inProgressVariables: ['customer_name', 'order_number', 'brand_name'],
  onHoldEnabled: false,
  onHoldTemplateName: '',
  onHoldLanguageCode: 'en',
  onHoldVariables: ['customer_name', 'order_number', 'brand_name'],
};

export const defaultSupportSettings: SupportSettings = {
  menuBody: 'Hi! Thanks for messaging {{brand_name}}. How can we help you today?',
  menuFooter: 'Tap an option below',
  statusButtonTitle: 'Order status',
  policyButtonTitle: 'Store policies',
  humanButtonTitle: 'Talk to support',
  menuCooldownHours: 12,
  handoffText:
    'Thanks — a team member from {{brand_name}} has been notified and will reply here shortly.',
  noOrderText:
    'We could not find an order linked to this WhatsApp number yet. Reply here if you used a different number or contact our support team.',
  clarifyText: 'Which order can we help with ({{orders}})? Please reply with the order number.',
  optOutKeywords: ['stop', 'unsubscribe', 'optout', 'opt out'],
  optInKeywords: ['start', 'subscribe', 'unstop'],
  optOutConfirmationText:
    'You have been unsubscribed from automated order notifications from {{brand_name}}. Reply START anytime to re-enable.',
  optedOutPhones: [],
};

export const defaultQuickReplies: QuickReply[] = [
  {
    label: 'Order confirmed',
    body: 'Thank you! Your order is confirmed and being prepared for dispatch.',
  },
  {
    label: 'Ask order #',
    body: 'Could you please share your order number (for example, #1001) so we can check this for you?',
  },
  {
    label: 'Order dispatched',
    body: 'Your order has been dispatched and is on its way. Reply here anytime if you need help.',
  },
  {
    label: 'Delivery timing',
    body: 'Standard delivery takes 2–4 working days depending on your city.',
  },
];

type SettingsCarrier = { settings: Workspace['settings'] };

export function shopifySyncSettings(w: SettingsCarrier) {
  const s = w.settings.shopifySync;
  return {
    ...defaultShopifySync,
    ...s,
    codGatewayKeywords: s?.codGatewayKeywords?.length
      ? s.codGatewayKeywords.map((k) => k.trim()).filter(Boolean)
      : defaultShopifySync.codGatewayKeywords,
    confirmedTag: s?.confirmedTag?.trim() || defaultShopifySync.confirmedTag,
    reviewTag: s?.reviewTag?.trim() || defaultShopifySync.reviewTag,
    cancellationRequestedTag:
      s?.cancellationRequestedTag?.trim() || defaultShopifySync.cancellationRequestedTag,
    holdReasonNotes: s?.holdReasonNotes?.trim() || defaultShopifySync.holdReasonNotes,
    syncCustomerSmsConsent: s?.syncCustomerSmsConsent ?? defaultShopifySync.syncCustomerSmsConsent!,
    checkoutConsentAttributeKey:
      s?.checkoutConsentAttributeKey?.trim() ?? defaultShopifySync.checkoutConsentAttributeKey!,
    checkoutConsentValues: s?.checkoutConsentValues?.length
      ? s.checkoutConsentValues.map((k) => k.trim().toLowerCase()).filter(Boolean)
      : defaultShopifySync.checkoutConsentValues!,
  };
}

export function dispatchSettings(w: SettingsCarrier) {
  const d = w.settings.dispatchNotifications;
  return {
    ...defaultDispatchNotifications,
    ...d,
    variables: d?.variables?.length ? d.variables : defaultDispatchNotifications.variables,
    deliveredVariables: d?.deliveredVariables?.length
      ? d.deliveredVariables
      : defaultDispatchNotifications.deliveredVariables,
    paidEnabled: Boolean(d?.paidEnabled),
    paidTemplateName: d?.paidTemplateName?.trim() ?? '',
    paidLanguageCode: d?.paidLanguageCode?.trim() || 'en',
    paidVariables: d?.paidVariables?.length
      ? d.paidVariables
      : defaultDispatchNotifications.paidVariables!,
    inProgressEnabled: Boolean(d?.inProgressEnabled),
    inProgressTemplateName: d?.inProgressTemplateName?.trim() ?? '',
    inProgressLanguageCode: d?.inProgressLanguageCode?.trim() || 'en',
    inProgressVariables: d?.inProgressVariables?.length
      ? d.inProgressVariables
      : defaultDispatchNotifications.inProgressVariables!,
    onHoldEnabled: Boolean(d?.onHoldEnabled),
    onHoldTemplateName: d?.onHoldTemplateName?.trim() ?? '',
    onHoldLanguageCode: d?.onHoldLanguageCode?.trim() || 'en',
    onHoldVariables: d?.onHoldVariables?.length
      ? d.onHoldVariables
      : defaultDispatchNotifications.onHoldVariables!,
  };
}

export function supportSettings(w: SettingsCarrier): SupportSettings {
  const s = w.settings.support;
  return {
    ...defaultSupportSettings,
    ...s,
    menuBody: s?.menuBody?.trim() || defaultSupportSettings.menuBody,
    menuFooter: s?.menuFooter?.trim() ?? defaultSupportSettings.menuFooter,
    statusButtonTitle: (
      s?.statusButtonTitle?.trim() || defaultSupportSettings.statusButtonTitle
    ).slice(0, 20),
    policyButtonTitle: (
      s?.policyButtonTitle?.trim() || defaultSupportSettings.policyButtonTitle
    ).slice(0, 20),
    humanButtonTitle: (
      s?.humanButtonTitle?.trim() || defaultSupportSettings.humanButtonTitle
    ).slice(0, 20),
    handoffText: s?.handoffText?.trim() || defaultSupportSettings.handoffText,
    noOrderText: s?.noOrderText?.trim() || defaultSupportSettings.noOrderText,
    clarifyText: s?.clarifyText?.trim() || defaultSupportSettings.clarifyText,
    optOutKeywords: s?.optOutKeywords?.length
      ? s.optOutKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean)
      : defaultSupportSettings.optOutKeywords,
    optInKeywords: s?.optInKeywords?.length
      ? s.optInKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean)
      : defaultSupportSettings.optInKeywords,
    optOutConfirmationText:
      s?.optOutConfirmationText?.trim() || defaultSupportSettings.optOutConfirmationText,
    optedOutPhones: [
      ...new Set((s?.optedOutPhones ?? []).map((p) => p.replace(/\D/g, '')).filter(Boolean)),
    ],
  };
}

export function quickReplies(w: SettingsCarrier): QuickReply[] {
  const list = w.settings.quickReplies;
  return list?.length ? list : defaultQuickReplies;
}

export function formatSupportTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

export function hasShopifyScope(
  integration: Pick<Integration, 'shopifyScopes'>,
  scope: string,
): boolean {
  const granted = (integration.shopifyScopes ?? []).map((s) => s.trim());
  if (!granted.length) return false;
  return (
    granted.includes(scope) ||
    (scope.startsWith('read_') && granted.includes(`write_${scope.slice(5)}`))
  );
}

export function isPhoneOptedOut(w: SettingsCarrier, normalizedPhone: string): boolean {
  const digits = normalizedPhone.replace(/\D/g, '');
  if (!digits) return false;
  return supportSettings(w).optedOutPhones.includes(digits);
}

export function orderMatchesPhone(o: Order, normalizedPhone: string): boolean {
  const digits = normalizedPhone.replace(/\D/g, '');
  if (!digits) return false;
  return o.phone === digits || !!o.linkedPhones?.includes(digits);
}

export function isCodGateway(gateways: string[], keywords: string[]): boolean {
  const active = keywords.length ? keywords : defaultShopifySync.codGatewayKeywords;
  return gateways.some((gateway) => {
    const lower = gateway.trim().toLowerCase();
    return active.some((kw) => {
      const k = kw.trim().toLowerCase();
      if (!k) return false;
      if (k === 'cod') return /\bcod\b/i.test(lower);
      return lower.includes(k);
    });
  });
}
