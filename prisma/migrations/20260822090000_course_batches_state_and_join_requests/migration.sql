-- Batches on students and courses, a course lifecycle state, join requests for
-- repeated students, a pass mark, and a target group size.
--
-- Written by hand because batch is NOT NULL on two tables that already hold
-- rows. Everything in the database today is test data, so existing rows are
-- given the LEGACY batch and their courses are archived — out of the way, and
-- obviously disposable.

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable: batch arrives with a default so existing rows fill in, then the
-- default is dropped so every future row has to say which batch it belongs to.
ALTER TABLE "students" ADD COLUMN "batch" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "students" ALTER COLUMN "batch" DROP DEFAULT;

ALTER TABLE "course_instances" ADD COLUMN "batch" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "course_instances" ALTER COLUMN "batch" DROP DEFAULT;

-- New courses start as drafts; the ones already here are archived, so nothing a
-- student joined disappears but no test course shows up as current.
ALTER TABLE "course_instances" ADD COLUMN "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT';
UPDATE "course_instances" SET "status" = 'ARCHIVED';

-- AlterTable: the pass mark and the group size the coordinator wants. Working
-- alone becomes the default, because a batch rarely divides evenly and the
-- student left over must still be able to proceed.
ALTER TABLE "cpi_policies"
    ADD COLUMN "pass_mark_percent" DOUBLE PRECISION,
    ADD COLUMN "target_group_size" INTEGER;

ALTER TABLE "cpi_policies" ALTER COLUMN "allow_individual_participation" SET DEFAULT true;
UPDATE "cpi_policies" SET "allow_individual_participation" = true;

-- CreateTable
CREATE TABLE "course_join_requests" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_join_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "students_batch_idx" ON "students"("batch");
CREATE INDEX "course_instances_department_batch_idx" ON "course_instances"("department", "batch");
CREATE UNIQUE INDEX "course_join_requests_course_instance_id_student_id_key" ON "course_join_requests"("course_instance_id", "student_id");
CREATE INDEX "course_join_requests_course_instance_id_idx" ON "course_join_requests"("course_instance_id");

-- AddForeignKey
ALTER TABLE "course_join_requests" ADD CONSTRAINT "course_join_requests_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_join_requests" ADD CONSTRAINT "course_join_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_join_requests" ADD CONSTRAINT "course_join_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
