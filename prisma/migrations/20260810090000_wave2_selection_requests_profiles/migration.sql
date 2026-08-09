-- Wave 2: co-supervisors, widened interest, supervisor requests, shared
-- provisioning log, directory profiles, and the missing race-safety constraint.
--
-- Hand-written where the generated script was destructive: it would have dropped
-- student_provisioning_log and recreated it empty, losing every credential
-- dispatch record. The table is renamed in place instead.

-- CreateEnum
CREATE TYPE "SupervisorRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "ProvisioningSubject" AS ENUM ('STUDENT', 'LECTURER');
CREATE TYPE "ResearchOutputKind" AS ENUM ('PUBLICATION', 'PROJECT', 'GRANT', 'OTHER');

-- AlterEnum
ALTER TYPE "EoiType" ADD VALUE 'LECTURER_INTEREST';
ALTER TYPE "EoiType" ADD VALUE 'CO_SUPERVISION_INTEREST';
ALTER TYPE "IdeaAuthorType" ADD VALUE 'LECTURER';

-- AlterTable: interest becomes a flat, withdrawable expression. `rank` goes —
-- with no declared preference there is nothing for first-come acceptance to
-- override, which is what made that race resolvable at all.
ALTER TABLE "interest_expressions" DROP COLUMN "rank",
    ADD COLUMN "withdrawn_at" TIMESTAMP(3);

ALTER TABLE "students" ADD COLUMN "registration_number" TEXT;
CREATE UNIQUE INDEX "students_registration_number_key" ON "students"("registration_number");

-- Rename rather than drop/create: the provisioning pipeline is identical for
-- students and lecturers, so the table is shared and its history is kept.
ALTER TABLE "student_provisioning_log" RENAME TO "provisioning_log";
ALTER TABLE "provisioning_log" ADD COLUMN "subject_type" "ProvisioningSubject" NOT NULL DEFAULT 'STUDENT';

ALTER TABLE "provisioning_log" RENAME CONSTRAINT "student_provisioning_log_pkey" TO "provisioning_log_pkey";
ALTER TABLE "provisioning_log" RENAME CONSTRAINT "student_provisioning_log_user_id_fkey" TO "provisioning_log_user_id_fkey";
ALTER INDEX "student_provisioning_log_batch_id_idx" RENAME TO "provisioning_log_batch_id_idx";
ALTER INDEX "student_provisioning_log_delivery_status_idx" RENAME TO "provisioning_log_delivery_status_idx";

-- CreateTable
CREATE TABLE "idea_supervisors" (
    "id" TEXT NOT NULL,
    "idea_id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "invitation_status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "idea_supervisors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supervisor_requests" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "status" "SupervisorRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisor_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "headline" TEXT,
    "about" TEXT,
    "department" TEXT,
    "designation" TEXT,
    "contact_email" TEXT,
    "links" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_interests" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "area" TEXT NOT NULL,

    CONSTRAINT "research_interests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "research_outputs" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "venue" TEXT,
    "year" INTEGER,
    "url" TEXT,
    "kind" "ResearchOutputKind" NOT NULL DEFAULT 'PUBLICATION',

    CONSTRAINT "research_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idea_supervisors_idea_id_idx" ON "idea_supervisors"("idea_id");
CREATE UNIQUE INDEX "idea_supervisors_idea_id_lecturer_id_key" ON "idea_supervisors"("idea_id", "lecturer_id");
CREATE INDEX "supervisor_requests_course_instance_id_idx" ON "supervisor_requests"("course_instance_id");
CREATE UNIQUE INDEX "supervisor_requests_course_instance_id_lecturer_id_key" ON "supervisor_requests"("course_instance_id", "lecturer_id");
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");
CREATE INDEX "research_interests_area_idx" ON "research_interests"("area");
CREATE UNIQUE INDEX "research_interests_profile_id_area_key" ON "research_interests"("profile_id", "area");
CREATE INDEX "research_outputs_profile_id_idx" ON "research_outputs"("profile_id");

-- AddForeignKey
ALTER TABLE "idea_supervisors" ADD CONSTRAINT "idea_supervisors_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "project_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idea_supervisors" ADD CONSTRAINT "idea_supervisors_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supervisor_requests" ADD CONSTRAINT "supervisor_requests_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supervisor_requests" ADD CONSTRAINT "supervisor_requests_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supervisor_requests" ADD CONSTRAINT "supervisor_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_interests" ADD CONSTRAINT "research_interests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_outputs" ADD CONSTRAINT "research_outputs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "user_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing idea's author becomes its primary supervisor, so the
-- co-supervisor list is complete from day one rather than starting empty.
INSERT INTO "idea_supervisors" ("id", "idea_id", "lecturer_id", "is_primary", "invitation_status", "responded_at")
SELECT gen_random_uuid()::text, pi."id", l."id", true, 'ACCEPTED'::"InvitationStatus", CURRENT_TIMESTAMP
FROM "project_ideas" pi
JOIN "lecturers" l ON l."user_id" = pi."author_user_id"
WHERE pi."author_type" = 'SUPERVISOR';

-- The race-safety constraint. Prisma cannot express a partial unique index, so
-- it is written directly: a group may hold at most one selection that is not
-- declined. This is what stops two supervisors both accepting the same group —
-- previously the second write succeeded and allocation later died with an
-- unmapped unique violation surfacing as HTTP 500.
--
-- Any pre-existing duplicates are declined oldest-first so the index can be
-- created; the surviving row is the most recent, which is the live one.
UPDATE "project_selections" ps
SET "status" = 'DECLINED', "responded_at" = COALESCE(ps."responded_at", CURRENT_TIMESTAMP)
WHERE ps."status" <> 'DECLINED'
  AND EXISTS (
    SELECT 1 FROM "project_selections" other
    WHERE other."group_id" = ps."group_id"
      AND other."status" <> 'DECLINED'
      AND (other."created_at" > ps."created_at" OR (other."created_at" = ps."created_at" AND other."id" > ps."id"))
  );

CREATE UNIQUE INDEX "project_selections_one_active_per_group"
    ON "project_selections" ("group_id")
    WHERE "status" <> 'DECLINED';
