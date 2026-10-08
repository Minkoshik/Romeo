-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- PostgreSQL's GiST operators protect a master's occupied time atomically.
-- Required by the exclusion constraints below; supported by local PostgreSQL.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "PrepaymentMode" AS ENUM ('DISABLED', 'FIXED', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('WAITING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('CLIENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ScheduleExceptionKind" AS ENUM ('CLOSED_DAY', 'REPLACE_DAY', 'BLOCKS_ONLY');

-- CreateEnum
CREATE TYPE "ScheduleIntervalKind" AS ENUM ('WORKING', 'BLOCKED');

-- CreateTable
CREATE TABLE "SalonSettings" (
    "id" TEXT NOT NULL DEFAULT 'salon',
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "logoUrl" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'RUB',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow',
    "phoneCountry" CHAR(2) NOT NULL DEFAULT 'RU',
    "bookingHorizonDays" INTEGER NOT NULL DEFAULT 60,
    "minimumLeadMinutes" INTEGER NOT NULL DEFAULT 120,
    "slotStepMinutes" INTEGER NOT NULL DEFAULT 30,
    "holdDurationMinutes" INTEGER NOT NULL DEFAULT 10,
    "prepaymentMode" "PrepaymentMode" NOT NULL DEFAULT 'DISABLED',
    "prepaymentFixedMinor" INTEGER,
    "prepaymentPercentageBps" INTEGER,
    "allowCustomerCancellation" BOOLEAN NOT NULL DEFAULT false,
    "allowCustomerReschedule" BOOLEAN NOT NULL DEFAULT false,
    "cancellationLeadMinutes" INTEGER NOT NULL DEFAULT 1440,
    "rescheduleLeadMinutes" INTEGER NOT NULL DEFAULT 1440,
    "bookingTerms" TEXT NOT NULL,
    "privacyTerms" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SalonSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCategory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "categoryId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortDescription" TEXT NOT NULL,
    "detailedDescription" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceVariant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "serviceId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Master" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specialization" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "photoUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isBookable" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterService" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "masterId" UUID NOT NULL,
    "serviceVariantId" UUID NOT NULL,
    "priceMinorOverride" INTEGER,
    "durationMinutesOverride" INTEGER,
    "bufferMinutesOverride" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MasterService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklySchedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "masterId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WeeklySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "masterId" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "kind" "ScheduleExceptionKind" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleExceptionInterval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scheduleExceptionId" UUID NOT NULL,
    "kind" "ScheduleIntervalKind" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "ScheduleExceptionInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "phoneNormalized" VARCHAR(32) NOT NULL,
    "email" TEXT,
    "adminNotes" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" SERIAL NOT NULL,
    "customerId" UUID NOT NULL,
    "masterId" UUID NOT NULL,
    "createdByAdminId" UUID,
    "source" "AppointmentSource" NOT NULL DEFAULT 'CLIENT',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'WAITING_PAYMENT',
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "occupiedUntil" TIMESTAMPTZ(3) NOT NULL,
    "holdExpiresAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancellationReason" TEXT,
    "customerComment" TEXT,
    "adminNotes" TEXT,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "publicAccessTokenHash" VARCHAR(128) NOT NULL,
    "salonNameSnapshot" TEXT NOT NULL,
    "salonAddressSnapshot" TEXT NOT NULL,
    "masterNameSnapshot" TEXT NOT NULL,
    "customerNameSnapshot" TEXT NOT NULL,
    "customerPhoneSnapshot" VARCHAR(32) NOT NULL,
    "customerEmailSnapshot" TEXT,
    "timezoneSnapshot" VARCHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "totalPriceMinor" INTEGER NOT NULL,
    "totalDurationMinutes" INTEGER NOT NULL,
    "totalBufferMinutes" INTEGER NOT NULL DEFAULT 0,
    "prepaymentModeSnapshot" "PrepaymentMode" NOT NULL,
    "prepaymentRequiredMinor" INTEGER NOT NULL,
    "prepaymentFixedMinorSnapshot" INTEGER,
    "prepaymentPercentageBpsSnapshot" INTEGER,
    "bookingTermsVersion" TEXT NOT NULL,
    "privacyTermsVersion" TEXT NOT NULL,
    "consentRecordedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointmentId" UUID NOT NULL,
    "serviceVariantId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "serviceNameSnapshot" TEXT NOT NULL,
    "variantNameSnapshot" TEXT NOT NULL,
    "priceMinorSnapshot" INTEGER NOT NULL,
    "durationMinutesSnapshot" INTEGER NOT NULL,
    "bufferMinutesSnapshot" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AppointmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointmentId" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "providerPaymentId" VARCHAR(255),
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "refundedAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attentionReason" TEXT,
    "failureCode" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "refundedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "emailNormalized" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entityType" VARCHAR(64) NOT NULL,
    "entityId" VARCHAR(128) NOT NULL,
    "changes" JSONB,
    "requestId" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCategory_slug_key" ON "ServiceCategory"("slug");

-- CreateIndex
CREATE INDEX "ServiceCategory_isActive_archivedAt_sortOrder_idx" ON "ServiceCategory"("isActive", "archivedAt", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Service_slug_key" ON "Service"("slug");

-- CreateIndex
CREATE INDEX "Service_categoryId_isActive_archivedAt_sortOrder_idx" ON "Service"("categoryId", "isActive", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "ServiceVariant_serviceId_isActive_archivedAt_sortOrder_idx" ON "ServiceVariant"("serviceId", "isActive", "archivedAt", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVariant_serviceId_slug_key" ON "ServiceVariant"("serviceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Master_slug_key" ON "Master"("slug");

-- CreateIndex
CREATE INDEX "Master_isBookable_archivedAt_sortOrder_idx" ON "Master"("isBookable", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "MasterService_serviceVariantId_isActive_idx" ON "MasterService"("serviceVariantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MasterService_masterId_serviceVariantId_key" ON "MasterService"("masterId", "serviceVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklySchedule_masterId_dayOfWeek_startMinute_key" ON "WeeklySchedule"("masterId", "dayOfWeek", "startMinute");

-- CreateIndex
CREATE INDEX "ScheduleException_localDate_idx" ON "ScheduleException"("localDate");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleException_masterId_localDate_key" ON "ScheduleException"("masterId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleExceptionInterval_scheduleExceptionId_kind_startMin_key" ON "ScheduleExceptionInterval"("scheduleExceptionId", "kind", "startMinute");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phoneNormalized_key" ON "Customer"("phoneNormalized");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "Customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_number_key" ON "Appointment"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_idempotencyKey_key" ON "Appointment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_publicAccessTokenHash_key" ON "Appointment"("publicAccessTokenHash");

-- CreateIndex
CREATE INDEX "Appointment_masterId_startsAt_status_idx" ON "Appointment"("masterId", "startsAt", "status");

-- CreateIndex
CREATE INDEX "Appointment_customerId_startsAt_idx" ON "Appointment"("customerId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_status_holdExpiresAt_idx" ON "Appointment"("status", "holdExpiresAt");

-- CreateIndex
CREATE INDEX "Appointment_startsAt_status_idx" ON "Appointment"("startsAt", "status");

-- CreateIndex
CREATE INDEX "AppointmentItem_serviceVariantId_idx" ON "AppointmentItem"("serviceVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentItem_appointmentId_position_key" ON "AppointmentItem"("appointmentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_appointmentId_status_idx" ON "Payment"("appointmentId", "status");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_needsAttention_createdAt_idx" ON "Payment"("needsAttention", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_mode_providerPaymentId_key" ON "Payment"("provider", "mode", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_emailNormalized_key" ON "AdminUser"("emailNormalized");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariant" ADD CONSTRAINT "ServiceVariant_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterService" ADD CONSTRAINT "MasterService_masterId_fkey" FOREIGN KEY ("masterId") REFERENCES "Master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterService" ADD CONSTRAINT "MasterService_serviceVariantId_fkey" FOREIGN KEY ("serviceVariantId") REFERENCES "ServiceVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklySchedule" ADD CONSTRAINT "WeeklySchedule_masterId_fkey" FOREIGN KEY ("masterId") REFERENCES "Master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_masterId_fkey" FOREIGN KEY ("masterId") REFERENCES "Master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleExceptionInterval" ADD CONSTRAINT "ScheduleExceptionInterval_scheduleExceptionId_fkey" FOREIGN KEY ("scheduleExceptionId") REFERENCES "ScheduleException"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_masterId_fkey" FOREIGN KEY ("masterId") REFERENCES "Master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentItem" ADD CONSTRAINT "AppointmentItem_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentItem" ADD CONSTRAINT "AppointmentItem_serviceVariantId_fkey" FOREIGN KEY ("serviceVariantId") REFERENCES "ServiceVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain checks and exclusions are intentionally maintained in SQL: Prisma
-- schema syntax cannot express PostgreSQL CHECK/EXCLUDE constraints.
ALTER TABLE "SalonSettings"
    ADD CONSTRAINT "SalonSettings_single_salon_check" CHECK ("id" = 'salon'),
    ADD CONSTRAINT "SalonSettings_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "SalonSettings_phone_country_check" CHECK ("phoneCountry" ~ '^[A-Z]{2}$'),
    ADD CONSTRAINT "SalonSettings_booking_limits_check" CHECK (
        "bookingHorizonDays" BETWEEN 1 AND 730 AND
        "minimumLeadMinutes" >= 0 AND
        "slotStepMinutes" BETWEEN 1 AND 1440 AND
        "holdDurationMinutes" BETWEEN 1 AND 1440 AND
        "cancellationLeadMinutes" >= 0 AND "rescheduleLeadMinutes" >= 0
    ),
    ADD CONSTRAINT "SalonSettings_prepayment_check" CHECK (
        ("prepaymentMode" = 'DISABLED' AND "prepaymentFixedMinor" IS NULL AND "prepaymentPercentageBps" IS NULL) OR
        ("prepaymentMode" = 'FIXED' AND "prepaymentFixedMinor" IS NOT NULL AND "prepaymentFixedMinor" > 0 AND "prepaymentPercentageBps" IS NULL) OR
        ("prepaymentMode" = 'PERCENTAGE' AND "prepaymentFixedMinor" IS NULL AND "prepaymentPercentageBps" IS NOT NULL AND "prepaymentPercentageBps" BETWEEN 1 AND 10000)
    );

ALTER TABLE "ServiceVariant"
    ADD CONSTRAINT "ServiceVariant_money_duration_check" CHECK (
        "priceMinor" >= 0 AND "durationMinutes" > 0 AND "bufferMinutes" >= 0
    );

ALTER TABLE "MasterService"
    ADD CONSTRAINT "MasterService_overrides_check" CHECK (
        ("priceMinorOverride" IS NULL OR "priceMinorOverride" >= 0) AND
        ("durationMinutesOverride" IS NULL OR "durationMinutesOverride" > 0) AND
        ("bufferMinutesOverride" IS NULL OR "bufferMinutesOverride" >= 0)
    );

ALTER TABLE "WeeklySchedule"
    ADD CONSTRAINT "WeeklySchedule_local_interval_check" CHECK (
        "dayOfWeek" BETWEEN 0 AND 6 AND "startMinute" >= 0 AND
        "endMinute" <= 1440 AND "startMinute" < "endMinute"
    ),
    ADD CONSTRAINT "WeeklySchedule_no_overlap" EXCLUDE USING gist (
        "masterId" WITH =,
        "dayOfWeek" WITH =,
        int4range("startMinute", "endMinute", '[)') WITH &&
    );

ALTER TABLE "ScheduleExceptionInterval"
    ADD CONSTRAINT "ScheduleExceptionInterval_local_interval_check" CHECK (
        "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute"
    ),
    ADD CONSTRAINT "ScheduleExceptionInterval_no_same_kind_overlap" EXCLUDE USING gist (
        "scheduleExceptionId" WITH =,
        "kind" WITH =,
        int4range("startMinute", "endMinute", '[)') WITH &&
    );

ALTER TABLE "Appointment"
    ADD CONSTRAINT "Appointment_interval_check" CHECK (
        "startsAt" < "endsAt" AND "endsAt" <= "occupiedUntil"
    ),
    ADD CONSTRAINT "Appointment_money_duration_check" CHECK (
        "totalPriceMinor" >= 0 AND "totalDurationMinutes" > 0 AND "totalBufferMinutes" >= 0 AND
        "prepaymentRequiredMinor" >= 0 AND "prepaymentRequiredMinor" <= "totalPriceMinor"
    ),
    ADD CONSTRAINT "Appointment_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "Appointment_hold_check" CHECK (
        "status" <> 'WAITING_PAYMENT' OR ("holdExpiresAt" IS NOT NULL AND "holdExpiresAt" > "createdAt")
    ),
    ADD CONSTRAINT "Appointment_prepayment_snapshot_check" CHECK (
        ("prepaymentModeSnapshot" = 'DISABLED' AND "prepaymentRequiredMinor" = 0 AND "prepaymentFixedMinorSnapshot" IS NULL AND "prepaymentPercentageBpsSnapshot" IS NULL) OR
        ("prepaymentModeSnapshot" = 'FIXED' AND "prepaymentFixedMinorSnapshot" IS NOT NULL AND "prepaymentFixedMinorSnapshot" > 0 AND "prepaymentPercentageBpsSnapshot" IS NULL) OR
        ("prepaymentModeSnapshot" = 'PERCENTAGE' AND "prepaymentFixedMinorSnapshot" IS NULL AND "prepaymentPercentageBpsSnapshot" IS NOT NULL AND "prepaymentPercentageBpsSnapshot" BETWEEN 1 AND 10000)
    ),
    ADD CONSTRAINT "Appointment_no_active_overlap" EXCLUDE USING gist (
        "masterId" WITH =,
        tstzrange("startsAt", "occupiedUntil", '[)') WITH &&
    ) WHERE ("status" IN ('WAITING_PAYMENT', 'CONFIRMED'));

ALTER TABLE "AppointmentItem"
    ADD CONSTRAINT "AppointmentItem_snapshot_check" CHECK (
        "position" >= 0 AND "priceMinorSnapshot" >= 0 AND
        "durationMinutesSnapshot" > 0 AND "bufferMinutesSnapshot" >= 0
    );

ALTER TABLE "Payment"
    ADD CONSTRAINT "Payment_money_check" CHECK (
        "amountMinor" > 0 AND "refundedAmountMinor" >= 0 AND "refundedAmountMinor" <= "amountMinor"
    ),
    ADD CONSTRAINT "Payment_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "AdminUser"
    ADD CONSTRAINT "AdminUser_session_version_check" CHECK ("sessionVersion" >= 0);
