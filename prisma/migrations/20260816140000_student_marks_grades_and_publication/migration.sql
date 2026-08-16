-- Per-student marks, grade bands, and publishing marks and comments separately.
--
-- Written by hand: dropping course_instances.marks_published_at would have lost
-- which courses had already published, so each of those is turned into a
-- mark_publications row first.

-- CreateTable
CREATE TABLE "student_marks" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "group_component_percent" DOUBLE PRECISION NOT NULL,
    "individual_component_percent" DOUBLE PRECISION,
    "stage_score_percent" DOUBLE PRECISION NOT NULL,
    "weighted_contribution" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_marks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "grade_bands" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "min_percent" DOUBLE PRECISION NOT NULL,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "grade_bands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mark_publications" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT,
    "publish_marks" BOOLEAN NOT NULL DEFAULT false,
    "publish_comments" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mark_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_marks_student_id_evaluation_stage_id_key" ON "student_marks"("student_id", "evaluation_stage_id");
CREATE INDEX "student_marks_course_instance_id_idx" ON "student_marks"("course_instance_id");
CREATE UNIQUE INDEX "grade_bands_course_instance_id_label_key" ON "grade_bands"("course_instance_id", "label");
CREATE INDEX "grade_bands_course_instance_id_idx" ON "grade_bands"("course_instance_id");
CREATE INDEX "mark_publications_course_instance_id_idx" ON "mark_publications"("course_instance_id");

-- Two partial indexes rather than one plain unique: Postgres treats nulls as
-- different from each other, so a normal unique on (course, stage) would let a
-- course collect several course-wide rows.
CREATE UNIQUE INDEX "mark_publications_course_stage_key"
    ON "mark_publications" ("course_instance_id", "evaluation_stage_id")
    WHERE "evaluation_stage_id" IS NOT NULL;
CREATE UNIQUE INDEX "mark_publications_course_overall_key"
    ON "mark_publications" ("course_instance_id")
    WHERE "evaluation_stage_id" IS NULL;

-- AddForeignKey
ALTER TABLE "student_marks" ADD CONSTRAINT "student_marks_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_marks" ADD CONSTRAINT "student_marks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_marks" ADD CONSTRAINT "student_marks_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_marks" ADD CONSTRAINT "student_marks_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grade_bands" ADD CONSTRAINT "grade_bands_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mark_publications" ADD CONSTRAINT "mark_publications_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mark_publications" ADD CONSTRAINT "mark_publications_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mark_publications" ADD CONSTRAINT "mark_publications_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep what was already published. Each course with a publish date becomes one
-- course-wide row with marks on. Comments stay off, because the old switch only
-- ever released the numbers.
INSERT INTO "mark_publications" ("id", "course_instance_id", "evaluation_stage_id", "publish_marks", "publish_comments", "published_at", "published_by_id", "updated_at")
SELECT
    gen_random_uuid()::text,
    ci."id",
    NULL,
    true,
    false,
    ci."marks_published_at",
    ci."created_by_id",
    CURRENT_TIMESTAMP
FROM "course_instances" ci
WHERE ci."marks_published_at" IS NOT NULL;

-- AlterTable
ALTER TABLE "course_instances" DROP COLUMN "marks_published_at";
