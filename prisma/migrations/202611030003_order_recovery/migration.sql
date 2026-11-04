ALTER TABLE "OrderLog" ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3), ADD COLUMN "messageBlockedReason" TEXT, ADD COLUMN "confirmationExpiresAt" TIMESTAMP(3);
DROP INDEX "OutboundMessage_jobId_key";
CREATE INDEX "OutboundMessage_merchantId_jobId_idx" ON "OutboundMessage"("merchantId","jobId");
