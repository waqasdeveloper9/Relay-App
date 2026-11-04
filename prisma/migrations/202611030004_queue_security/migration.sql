-- Only the backend table owner may access recovery payloads and notifications.
ALTER TABLE "InboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifySyncState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MerchantNotification" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "InboxEvent", "ShopifySyncState", "MerchantNotification" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON "InboxEvent", "ShopifySyncState", "MerchantNotification" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
