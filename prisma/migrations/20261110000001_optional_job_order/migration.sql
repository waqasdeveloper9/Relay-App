ALTER TABLE "AutomationJob" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AutomationJob_merchantId_kind_idx" ON "AutomationJob"("merchantId", "kind");
