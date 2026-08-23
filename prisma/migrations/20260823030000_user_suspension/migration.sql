-- Suspension deactivates an account without deleting it: marks, scores and audit
-- rows all reference users, so deleting a participant would take that history.
-- The reason is stored so whoever reinstates the account can read it.
ALTER TABLE "users" ADD COLUMN "suspended_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "suspended_reason" TEXT;
ALTER TABLE "users" ADD COLUMN "suspended_by_id" TEXT;

-- SET NULL: deleting whoever issued a suspension must not delete the account.
ALTER TABLE "users"
  ADD CONSTRAINT "users_suspended_by_id_fkey"
  FOREIGN KEY ("suspended_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "users_suspended_by_id_idx" ON "users"("suspended_by_id");
