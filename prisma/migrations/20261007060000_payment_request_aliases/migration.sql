CREATE TABLE "PaymentRequest" (
  "idempotencyKey" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("idempotencyKey"),
  CONSTRAINT "PaymentRequest_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PaymentRequest_paymentId_idx" ON "PaymentRequest"("paymentId");

-- Existing UUID request keys also retain their original attempt.
INSERT INTO "PaymentRequest" ("idempotencyKey", "paymentId", "createdAt")
SELECT "idempotencyKey"::uuid, "id", "createdAt" FROM "Payment"
WHERE "idempotencyKey" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
