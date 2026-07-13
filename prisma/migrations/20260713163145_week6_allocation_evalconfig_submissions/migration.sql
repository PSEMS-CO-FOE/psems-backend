-- CreateEnum
CREATE TYPE "AllocationSource" AS ENUM ('FROM_SELECTION', 'COORDINATOR_OVERRIDE');

-- AlterTable
ALTER TABLE "course_instances" ADD COLUMN     "allocations_finalized_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "project_allocations" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "idea_id" TEXT NOT NULL,
    "supervisor_lecturer_id" TEXT,
    "source" "AllocationSource" NOT NULL DEFAULT 'FROM_SELECTION',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_stages" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "evaluators_required" INTEGER NOT NULL,
    "submission_required" BOOLEAN NOT NULL DEFAULT false,
    "order_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_criteria" (
    "id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL,
    "max_score" INTEGER NOT NULL,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "rubric_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_evaluators" (
    "id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "cpi_evaluator_id" TEXT NOT NULL,

    CONSTRAINT "stage_evaluators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_allocations_group_id_key" ON "project_allocations"("group_id");

-- CreateIndex
CREATE INDEX "project_allocations_course_instance_id_idx" ON "project_allocations"("course_instance_id");

-- CreateIndex
CREATE INDEX "evaluation_stages_course_instance_id_idx" ON "evaluation_stages"("course_instance_id");

-- CreateIndex
CREATE INDEX "rubric_criteria_evaluation_stage_id_idx" ON "rubric_criteria"("evaluation_stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "stage_evaluators_evaluation_stage_id_cpi_evaluator_id_key" ON "stage_evaluators"("evaluation_stage_id", "cpi_evaluator_id");

-- CreateIndex
CREATE INDEX "submissions_course_instance_id_idx" ON "submissions"("course_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_group_id_evaluation_stage_id_key" ON "submissions"("group_id", "evaluation_stage_id");

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "project_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_supervisor_lecturer_id_fkey" FOREIGN KEY ("supervisor_lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_stages" ADD CONSTRAINT "evaluation_stages_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_evaluators" ADD CONSTRAINT "stage_evaluators_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_evaluators" ADD CONSTRAINT "stage_evaluators_cpi_evaluator_id_fkey" FOREIGN KEY ("cpi_evaluator_id") REFERENCES "cpi_evaluators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
