-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('SCHEDULED', 'AWAITING_HEAD_JUDGE', 'CORRECTION_REQUESTED', 'FINALIZED');

-- CreateEnum
CREATE TYPE "RubricScoreStatus" AS ENUM ('PENDING', 'FINALIZED');

-- CreateEnum
CREATE TYPE "HeadJudgeDecision" AS ENUM ('APPROVED', 'CORRECTION_REQUESTED');

-- CreateTable
CREATE TABLE "evaluator_availability" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "cpi_evaluator_id" TEXT NOT NULL,
    "slot_start" TIMESTAMP(3) NOT NULL,
    "slot_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluator_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_sessions" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "scheduled_start" TIMESTAMP(3),
    "scheduled_end" TIMESTAMP(3),
    "status" "SessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_scores" (
    "id" TEXT NOT NULL,
    "evaluation_session_id" TEXT NOT NULL,
    "cpi_evaluator_id" TEXT NOT NULL,
    "rubric_criterion_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "status" "RubricScoreStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rubric_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "head_judge_reviews" (
    "id" TEXT NOT NULL,
    "evaluation_session_id" TEXT NOT NULL,
    "head_judge_cpi_evaluator_id" TEXT NOT NULL,
    "decision" "HeadJudgeDecision" NOT NULL,
    "reason" TEXT,
    "correction_evaluator_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "head_judge_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evaluator_availability_course_instance_id_idx" ON "evaluator_availability"("course_instance_id");

-- CreateIndex
CREATE INDEX "evaluation_sessions_course_instance_id_idx" ON "evaluation_sessions"("course_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_sessions_group_id_evaluation_stage_id_key" ON "evaluation_sessions"("group_id", "evaluation_stage_id");

-- CreateIndex
CREATE INDEX "rubric_scores_evaluation_session_id_idx" ON "rubric_scores"("evaluation_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "rubric_scores_evaluation_session_id_cpi_evaluator_id_rubric_key" ON "rubric_scores"("evaluation_session_id", "cpi_evaluator_id", "rubric_criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "head_judge_reviews_evaluation_session_id_key" ON "head_judge_reviews"("evaluation_session_id");

-- AddForeignKey
ALTER TABLE "evaluator_availability" ADD CONSTRAINT "evaluator_availability_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluator_availability" ADD CONSTRAINT "evaluator_availability_cpi_evaluator_id_fkey" FOREIGN KEY ("cpi_evaluator_id") REFERENCES "cpi_evaluators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_sessions" ADD CONSTRAINT "evaluation_sessions_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_sessions" ADD CONSTRAINT "evaluation_sessions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_sessions" ADD CONSTRAINT "evaluation_sessions_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_scores" ADD CONSTRAINT "rubric_scores_evaluation_session_id_fkey" FOREIGN KEY ("evaluation_session_id") REFERENCES "evaluation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_scores" ADD CONSTRAINT "rubric_scores_cpi_evaluator_id_fkey" FOREIGN KEY ("cpi_evaluator_id") REFERENCES "cpi_evaluators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_scores" ADD CONSTRAINT "rubric_scores_rubric_criterion_id_fkey" FOREIGN KEY ("rubric_criterion_id") REFERENCES "rubric_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_judge_reviews" ADD CONSTRAINT "head_judge_reviews_evaluation_session_id_fkey" FOREIGN KEY ("evaluation_session_id") REFERENCES "evaluation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
