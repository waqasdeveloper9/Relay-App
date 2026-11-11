ALTER TABLE "OrderLog" ADD COLUMN "isCod" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "OrderLog" ADD COLUMN "financialStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "OrderLog" ADD COLUMN "paymentMethod" TEXT NOT NULL DEFAULT 'Cash on delivery';
ALTER TABLE "OrderLog" ADD COLUMN "fulfillmentStatus" TEXT;
ALTER TABLE "OrderLog" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "OrderLog" ADD COLUMN "trackingCompany" TEXT;
ALTER TABLE "OrderLog" ADD COLUMN "linkedPhones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
