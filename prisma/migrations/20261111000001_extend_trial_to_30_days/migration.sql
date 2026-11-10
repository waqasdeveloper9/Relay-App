UPDATE "Merchant"
SET "trialEndsAt" = "trialStartsAt" + INTERVAL '30 days',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "subscriptionStatus" = 'TRIALING'
  AND "trialEndsAt" < "trialStartsAt" + INTERVAL '30 days';
