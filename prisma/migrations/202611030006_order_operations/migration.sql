ALTER TABLE "OrderLog" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "ShopifySyncState" ADD COLUMN "manualRequested" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "restoreArchived" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "OrderLog_merchantId_archivedAt_idx" ON "OrderLog"("merchantId","archivedAt");
