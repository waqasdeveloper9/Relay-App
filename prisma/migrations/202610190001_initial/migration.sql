-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'NEEDS_REVIEW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'APPROVED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('QUEUED', 'DONE', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trialStartsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "merchantId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "ShopifyIntegration" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "shopDomain" TEXT,
    "accessToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppIntegration" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "phoneNumberId" TEXT,
    "wabaId" TEXT NOT NULL,
    "systemAccessToken" TEXT NOT NULL,
    "templateName" TEXT NOT NULL DEFAULT 'order_confirmation_v1',
    "languageCode" TEXT NOT NULL DEFAULT 'en_US',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLog" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "delivery" TEXT NOT NULL DEFAULT 'Unfulfilled',
    "trackingUrl" TEXT,
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "human" BOOLEAN NOT NULL DEFAULT false,
    "unread" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerRequest" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationJob" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "messageId" TEXT,
    "error" TEXT,

    CONSTRAINT "AutomationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyIntegration_merchantId_key" ON "ShopifyIntegration"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyIntegration_shopDomain_key" ON "ShopifyIntegration"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIntegration_merchantId_key" ON "WhatsAppIntegration"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppIntegration_phoneNumberId_key" ON "WhatsAppIntegration"("phoneNumberId");

-- CreateIndex
CREATE INDEX "OrderLog_merchantId_status_createdAt_idx" ON "OrderLog"("merchantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderLog_merchantId_phone_idx" ON "OrderLog"("merchantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLog_merchantId_shopifyOrderId_key" ON "OrderLog"("merchantId", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLog_merchantId_id_key" ON "OrderLog"("merchantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_orderId_key" ON "Conversation"("orderId");

-- CreateIndex
CREATE INDEX "Conversation_merchantId_unread_idx" ON "Conversation"("merchantId", "unread");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_merchantId_orderId_key" ON "Conversation"("merchantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_merchantId_id_key" ON "Conversation"("merchantId", "id");

-- CreateIndex
CREATE INDEX "Message_merchantId_conversationId_createdAt_idx" ON "Message"("merchantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerRequest_merchantId_status_idx" ON "CustomerRequest"("merchantId", "status");

-- CreateIndex
CREATE INDEX "AutomationJob_state_dueAt_idx" ON "AutomationJob"("state", "dueAt");

-- CreateIndex
CREATE INDEX "AutomationJob_merchantId_messageId_idx" ON "AutomationJob"("merchantId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationJob_merchantId_orderId_kind_key" ON "AutomationJob"("merchantId", "orderId", "kind");

-- CreateIndex
CREATE INDEX "Activity_merchantId_createdAt_idx" ON "Activity"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_merchantId_eventId_key" ON "WebhookReceipt"("merchantId", "eventId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyIntegration" ADD CONSTRAINT "ShopifyIntegration_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppIntegration" ADD CONSTRAINT "WhatsAppIntegration_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLog" ADD CONSTRAINT "OrderLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_merchantId_orderId_fkey" FOREIGN KEY ("merchantId", "orderId") REFERENCES "OrderLog"("merchantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_merchantId_conversationId_fkey" FOREIGN KEY ("merchantId", "conversationId") REFERENCES "Conversation"("merchantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerRequest" ADD CONSTRAINT "CustomerRequest_merchantId_orderId_fkey" FOREIGN KEY ("merchantId", "orderId") REFERENCES "OrderLog"("merchantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_merchantId_orderId_fkey" FOREIGN KEY ("merchantId", "orderId") REFERENCES "OrderLog"("merchantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
