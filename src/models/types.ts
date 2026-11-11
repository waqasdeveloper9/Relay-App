export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'NEEDS_REVIEW' | 'CANCELLED';
export type DeliveryStatus =
  | 'Unfulfilled'
  | 'In progress'
  | 'On hold'
  | 'Scheduled'
  | 'Partially fulfilled'
  | 'In transit'
  | 'Delivered'
  | 'Restocked'
  | 'Fulfillment not required';
export type Page =
  | 'Messages'
  | 'Overview'
  | 'Orders'
  | 'Inbox'
  | 'Automations'
  | 'Integrations'
  | 'Reliability'
  | 'Reports'
  | 'Settings';
export interface Merchant {
  id: string;
  email: string;
  passwordHash: string;
  brandName: string;
  subscriptionStatus: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  trialEndsAt: string;
  createdAt: string;
}
export interface Order {
  id: string;
  shopifyOrderId: string;
  number: string;
  name: string;
  phone: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  isCod?: boolean;
  financialStatus?: string;
  paymentMethod?: string;
  createdAt: string;
  delivery: DeliveryStatus;
  fulfillmentStatus?: string;
  trackingUrl?: string;
  trackingNumber?: string;
  trackingCompany?: string;
  linkedPhones?: string[];
  consent: boolean;
  archivedAt?: string;
  sourceUpdatedAt?: string;
  messageBlockedReason?: string;
  confirmationExpiresAt?: string;
  tags: string[];
}
export interface Message {
  id: string;
  direction: 'in' | 'out' | 'note';
  text: string;
  createdAt: string;
}
export interface Conversation {
  id: string;
  orderId?: string;
  phone?: string;
  human: boolean;
  unread: boolean;
  messages: Message[];
}
export interface Task {
  id: string;
  orderId: string;
  kind: 'Address change' | 'Cancellation' | 'Customer support';
  detail: string;
  status: 'OPEN' | 'APPROVED' | 'VERIFIED';
  createdAt: string;
}
export interface OrderView {
  id: string;
  name: string;
  tab: string;
  paymentFilter: string;
  fulfillmentFilter: string;
  search: string;
}
export type ShopifyOrderAction =
  | 'mark_paid'
  | 'mark_in_progress'
  | 'reopen'
  | 'hold'
  | 'release_hold'
  | 'fulfill'
  | 'update_tracking'
  | 'mark_delivered';
export interface OrderActionPayload {
  trackingCompany?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  notifyCustomer?: boolean;
  reasonNotes?: string;
}
export interface Job {
  id: string;
  orderId?: string;
  kind:
    | 'CONFIRMATION'
    | 'REMINDER'
    | 'TAG'
    | 'REVIEW_TAG'
    | 'FULFILLMENT_HOLD'
    | 'FULFILLMENT_RELEASE'
    | 'MARK_PAID'
    | 'MARK_IN_PROGRESS'
    | 'MARK_OPEN'
    | 'FULFILL_ORDER'
    | 'UPDATE_TRACKING'
    | 'MARK_DELIVERED'
    | 'DISPATCH_NOTICE'
    | 'DELIVERY_NOTICE'
    | 'PAYMENT_NOTICE'
    | 'IN_PROGRESS_NOTICE'
    | 'ON_HOLD_NOTICE'
    | 'TEST_HELLO'
    | 'TEST_CONFIRMATION'
    | 'CANCEL'
    | 'CANCEL_TAGS'
    | 'CANCEL_CLEANUP'
    | `SUPPORT_REPLY:${string}`;
  state: 'QUEUED' | 'DONE' | 'FAILED' | 'UNKNOWN';
  attempts: number;
  claimedAt?: string;
  retryable?: boolean;
  dueAt: string;
  messageId?: string;
  error?: string;
  payload?: OrderActionPayload;
}
export interface Integration {
  shopDomain: string;
  shopifyToken: string;
  shopifyVerifiedAt?: string;
  shopifyRefreshToken?: string;
  shopifyTokenExpiresAt?: string;
  shopifyRefreshExpiresAt?: string;
  shopifyScopes?: string[];
  shopifyWebhooksVerifiedAt?: string;
  shopifyWebhooksUrl?: string;
  phoneNumberId: string;
  wabaId: string;
  whatsappToken: string;
  whatsappVerifiedAt?: string;
  metaAppSecret?: string;
  metaVerifyTokenHash?: string;
  metaWebhookVerifiedAt?: string;
  metaWebhookLastReceivedAt?: string;
  metaWebhookUrl?: string;
  templateName: string;
  languageCode: string;
}
export interface OutboundMessage {
  id: string;
  orderId?: string;
  jobId?: string;
  kind: string;
  recipient: string;
  templateName: string;
  languageCode: string;
  preview: string;
  status: 'SENDING' | 'ACCEPTED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN';
  messageId?: string;
  error?: string;
  statusTimestamp?: string;
  createdAt: string;
  updatedAt: string;
}
export interface MerchantNotification {
  id: string;
  key: string;
  severity: 'warning' | 'error' | 'info';
  title: string;
  detail: string;
  action: string;
  readAt?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ReliabilitySettings {
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  initialLookbackDays: number;
  maxMessageAgeHours: number;
  recoveryMessaging: 'REVIEW' | 'SEND_ELIGIBLE';
  testMode?: { recipient: string; until: string; template: string };
}
export type DispatchVariableKey =
  | 'customer_name'
  | 'brand_name'
  | 'order_number'
  | 'courier'
  | 'tracking_number'
  | 'tracking_url'
  | 'total_amount';
export interface ShopifySyncSettings {
  importNonCodOrders: boolean;
  codGatewayKeywords: string[];
  confirmedTag: string;
  reviewTag: string;
  cancellationRequestedTag: string;
  tagOnReview: boolean;
  autoHoldUnconfirmed: boolean;
  holdOnReview: boolean;
  holdOnCancellationRequest: boolean;
  releaseHoldOnConfirm: boolean;
  holdReasonNotes: string;
  syncCustomerSmsConsent?: boolean;
  checkoutConsentAttributeKey?: string;
  checkoutConsentValues?: string[];
}
export interface DispatchNotificationSettings {
  enabled: boolean;
  templateName: string;
  languageCode: string;
  variables: DispatchVariableKey[];
  includeTrackingButtonUrl: boolean;
  notifyOnPartial: boolean;
  deliveredEnabled: boolean;
  deliveredTemplateName: string;
  deliveredLanguageCode: string;
  deliveredVariables: DispatchVariableKey[];
  paidEnabled?: boolean;
  paidTemplateName?: string;
  paidLanguageCode?: string;
  paidVariables?: DispatchVariableKey[];
  inProgressEnabled?: boolean;
  inProgressTemplateName?: string;
  inProgressLanguageCode?: string;
  inProgressVariables?: DispatchVariableKey[];
  onHoldEnabled?: boolean;
  onHoldTemplateName?: string;
  onHoldLanguageCode?: string;
  onHoldVariables?: DispatchVariableKey[];
}
export interface SupportSettings {
  menuBody: string;
  menuFooter: string;
  statusButtonTitle: string;
  policyButtonTitle: string;
  humanButtonTitle: string;
  menuCooldownHours: number;
  handoffText: string;
  noOrderText: string;
  clarifyText: string;
  optOutKeywords: string[];
  optInKeywords: string[];
  optOutConfirmationText: string;
  optedOutPhones: string[];
}
export interface QuickReply {
  label: string;
  body: string;
}
export interface Workspace {
  notifications?: MerchantNotification[];
  outboundMessages?: OutboundMessage[];
  orders: Order[];
  conversations: Conversation[];
  tasks: Task[];
  jobs: Job[];
  integration: Integration;
  settings: {
    reliability?: ReliabilitySettings;
    shopifySync?: ShopifySyncSettings;
    dispatchNotifications?: DispatchNotificationSettings;
    support?: SupportSettings;
    quickReplies?: QuickReply[];
    orderViews?: OrderView[];
    metaSubscription?: { wabaId: string; verifiedAt: string };
    testRecipient?: string;
    savedTemplates?: { id: string; name: string; language: string }[];
    confirmations: boolean;
    reminders: boolean;
    faqs: boolean;
    tracking: boolean;
    reminderHours: number;
    timezone: string;
    policy: string;
  };
  activity: { id: string; text: string; createdAt: string }[];
  processedEvents: string[];
}
export interface Store {
  merchant: Merchant;
  workspace: Workspace;
}
