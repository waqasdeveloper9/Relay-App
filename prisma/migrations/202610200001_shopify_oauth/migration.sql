ALTER TABLE "ShopifyIntegration"
  ADD COLUMN "refreshToken" TEXT,
  ADD COLUMN "tokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "refreshExpiresAt" TIMESTAMP(3),
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "webhooksVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "webhooksUrl" TEXT,
  ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3);

CREATE TABLE "ShopifyOAuthAttempt" (
  "stateHash" TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopifyOAuthAttempt_pkey" PRIMARY KEY ("stateHash")
);

CREATE INDEX "ShopifyOAuthAttempt_expiresAt_idx" ON "ShopifyOAuthAttempt"("expiresAt");
CREATE INDEX "ShopifyOAuthAttempt_merchantId_idx" ON "ShopifyOAuthAttempt"("merchantId");
ALTER TABLE "ShopifyOAuthAttempt" ADD CONSTRAINT "ShopifyOAuthAttempt_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
