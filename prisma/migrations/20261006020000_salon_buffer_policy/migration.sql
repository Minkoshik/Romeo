-- Shared salon policy is distinct from an individual service's technical buffer.
ALTER TABLE "SalonSettings"
  ADD COLUMN "bufferMinutes" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "SalonSettings"
  ADD CONSTRAINT "SalonSettings_bufferMinutes_check"
  CHECK ("bufferMinutes" >= 0 AND "bufferMinutes" <= 120);

-- Zero prepayment is already a supported public policy and skips demo payment.
ALTER TABLE "SalonSettings"
  DROP CONSTRAINT "SalonSettings_prepayment_check";

ALTER TABLE "SalonSettings"
  ADD CONSTRAINT "SalonSettings_prepayment_check" CHECK (
    ("prepaymentMode" = 'DISABLED' AND "prepaymentFixedMinor" IS NULL AND "prepaymentPercentageBps" IS NULL) OR
    ("prepaymentMode" = 'FIXED' AND "prepaymentFixedMinor" IS NOT NULL AND "prepaymentFixedMinor" >= 0 AND "prepaymentPercentageBps" IS NULL) OR
    ("prepaymentMode" = 'PERCENTAGE' AND "prepaymentFixedMinor" IS NULL AND "prepaymentPercentageBps" IS NOT NULL AND "prepaymentPercentageBps" BETWEEN 0 AND 10000)
  );
