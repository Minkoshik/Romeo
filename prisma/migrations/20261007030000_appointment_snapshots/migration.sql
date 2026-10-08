-- Empty defaults preserve historical rows without inventing historical terms.
ALTER TABLE "Appointment"
  ADD COLUMN "requestFingerprint" VARCHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN "salonPhoneSnapshot" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "phoneCountrySnapshot" CHAR(2) NOT NULL DEFAULT 'RU',
  ADD COLUMN "bookingTermsSnapshot" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "privacyTermsSnapshot" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_request_fingerprint_check"
    CHECK ("requestFingerprint" = '' OR "requestFingerprint" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "Appointment_phone_country_snapshot_check"
    CHECK ("phoneCountrySnapshot" ~ '^[A-Z]{2}$');

-- SalonSettings already permits a zero configured prepayment. Preserve the
-- policy snapshot even if the effective payment is zero and no hold is needed.
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_prepayment_snapshot_check";
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_prepayment_snapshot_check" CHECK (
  ("prepaymentModeSnapshot" = 'DISABLED' AND "prepaymentRequiredMinor" = 0 AND "prepaymentFixedMinorSnapshot" IS NULL AND "prepaymentPercentageBpsSnapshot" IS NULL) OR
  ("prepaymentModeSnapshot" = 'FIXED' AND "prepaymentFixedMinorSnapshot" IS NOT NULL AND "prepaymentFixedMinorSnapshot" >= 0 AND "prepaymentPercentageBpsSnapshot" IS NULL) OR
  ("prepaymentModeSnapshot" = 'PERCENTAGE' AND "prepaymentFixedMinorSnapshot" IS NULL AND "prepaymentPercentageBpsSnapshot" IS NOT NULL AND "prepaymentPercentageBpsSnapshot" BETWEEN 0 AND 10000)
);
