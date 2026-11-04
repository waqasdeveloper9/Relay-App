CREATE TABLE "OutboundMessage" (
 "id" TEXT NOT NULL, "merchantId" TEXT NOT NULL, "orderId" TEXT, "jobId" TEXT,
 "kind" TEXT NOT NULL, "recipient" TEXT NOT NULL, "templateName" TEXT NOT NULL,
 "languageCode" TEXT NOT NULL, "preview" TEXT NOT NULL, "status" TEXT NOT NULL,
 "messageId" TEXT, "error" TEXT, "statusTimestamp" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "OutboundMessage_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "OutboundMessage_merchantId_orderId_fkey" FOREIGN KEY ("merchantId", "orderId") REFERENCES "OrderLog"("merchantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OutboundMessage_jobId_key" ON "OutboundMessage"("jobId");
CREATE UNIQUE INDEX "OutboundMessage_merchantId_messageId_key" ON "OutboundMessage"("merchantId", "messageId");
CREATE INDEX "OutboundMessage_merchantId_createdAt_idx" ON "OutboundMessage"("merchantId", "createdAt");
