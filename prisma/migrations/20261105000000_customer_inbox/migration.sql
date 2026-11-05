ALTER TABLE "Conversation" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "Conversation" ADD COLUMN "phone" TEXT;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Conversation_merchantId_phone_idx" ON "Conversation"("merchantId", "phone");
