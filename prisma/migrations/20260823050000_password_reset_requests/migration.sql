CREATE TYPE "PasswordResetRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'DISMISSED');

CREATE TABLE "password_reset_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "user_id" TEXT,
    "note" TEXT,
    "status" "PasswordResetRequestStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled_at" TIMESTAMP(3),
    "handled_by_id" TEXT,

    CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_reset_requests_status_created_at_idx" ON "password_reset_requests"("status", "created_at");
CREATE INDEX "password_reset_requests_user_id_idx" ON "password_reset_requests"("user_id");

-- One open request per address. The endpoint cannot require a session, so
-- without this a script could fill the table. Partial, so a completed request
-- does not block the next one; Prisma cannot express it.
CREATE UNIQUE INDEX "password_reset_requests_email_pending_key"
    ON "password_reset_requests"("email") WHERE "status" = 'PENDING';

ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL: removing whoever handled a request must not remove the request.
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_handled_by_id_fkey"
    FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New tables are not covered by the earlier lockdown, so close this one here.
ALTER TABLE "password_reset_requests" ENABLE ROW LEVEL SECURITY;
