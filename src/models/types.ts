export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'NEEDS_REVIEW' | 'CANCELLED';
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
  createdAt: string;
  delivery: 'Unfulfilled' | 'In transit' | 'Delivered';
  trackingUrl?: string;
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
  orderId: string;
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
export interface Job {
  id: string;
  orderId: string;
  kind:
    | 'CONFIRMATION'
    | 'REMINDER'
    | 'TAG'
    | 'TEST_HELLO'
    | 'TEST_CONFIRMATION'
    | 'CANCEL'
    | 'CANCEL_TAGS'
    | 'CANCEL_CLEANUP';
  state: 'QUEUED' | 'DONE' | 'FAILED' | 'UNKNOWN';
  attempts: number;
  claimedAt?: string;
  retryable?: boolean;
  dueAt: string;
  messageId?: string;
  error?: string;
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
