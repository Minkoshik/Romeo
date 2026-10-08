CREATE TABLE "PaymentEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "paymentId" UUID NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "mode" "PaymentMode" NOT NULL,
  "eventId" VARCHAR(128) NOT NULL,
  "payloadFingerprint" VARCHAR(64) NOT NULL,
  "status" "PaymentStatus" NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PaymentEvent_fingerprint_check" CHECK ("payloadFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "PaymentEvent_status_check" CHECK ("status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'))
);
CREATE UNIQUE INDEX "PaymentEvent_provider_mode_eventId_key" ON "PaymentEvent"("provider", "mode", "eventId");
CREATE INDEX "PaymentEvent_paymentId_receivedAt_idx" ON "PaymentEvent"("paymentId", "receivedAt");
CREATE UNIQUE INDEX "Payment_one_pending_per_appointment" ON "Payment"("appointmentId") WHERE "status" = 'PENDING';
