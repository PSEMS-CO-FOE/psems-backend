-- Evaluation panels + per-CPI policy.
--
-- Written by hand rather than generated: the generated script drops
-- rubric_scores.cpi_evaluator_id and head_judge_reviews outright, which would
-- discard live pilot data. Every destructive step here is preceded by a
-- backfill, and the seeded policy rows reproduce each CPI's current behaviour
-- exactly so nothing changes for courses already in flight.

-- CreateEnum
CREATE TYPE "SelectionConfirmer" AS ENUM ('SUPERVISOR', 'COORDINATOR', 'EITHER');
CREATE TYPE "AvailabilityRequirement" AS ENUM ('EVALUATORS_ONLY', 'EVALUATORS_AND_SUPERVISORS', 'NONE');
CREATE TYPE "PanelRole" AS ENUM ('COORDINATOR', 'SUPERVISOR', 'CO_SUPERVISOR', 'SENIOR_EVALUATOR', 'EVALUATOR', 'JUNIOR_EVALUATOR', 'HEAD_JUDGE', 'OBSERVER');
CREATE TYPE "MarkCounting" AS ENUM ('COUNTED', 'ADVISORY', 'COORDINATOR_DECIDES');
CREATE TYPE "PanelScoreVisibility" AS ENUM ('ISOLATED', 'OPEN_WITH_NAMES', 'OPEN_ANONYMOUS');
CREATE TYPE "CriterionLevel" AS ENUM ('GROUP', 'INDIVIDUAL');
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'CORRECTION_REQUESTED');

-- AlterEnum
-- Rename in place instead of the generated create-cast-swap: the cast would
-- fail on any session currently sitting at AWAITING_HEAD_JUDGE.
ALTER TYPE "SessionStatus" RENAME VALUE 'AWAITING_HEAD_JUDGE' TO 'AWAITING_REVIEW';

-- CreateTable
CREATE TABLE "cpi_policies" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "allow_student_ideas" BOOLEAN NOT NULL DEFAULT true,
    "student_ideas_leader_only" BOOLEAN NOT NULL DEFAULT true,
    "allow_supervisor_ideas" BOOLEAN NOT NULL DEFAULT true,
    "allow_coordinator_ideas" BOOLEAN NOT NULL DEFAULT true,
    "allow_lecturer_ideas" BOOLEAN NOT NULL DEFAULT false,
    "require_student_idea_approval" BOOLEAN NOT NULL DEFAULT false,
    "max_ideas_per_group" INTEGER,
    "allow_co_supervisor_on_idea" BOOLEAN NOT NULL DEFAULT true,
    "interest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "max_interests_per_group" INTEGER,
    "allow_interest_withdrawal" BOOLEAN NOT NULL DEFAULT true,
    "allow_lecturer_interest_in_group_ideas" BOOLEAN NOT NULL DEFAULT true,
    "allow_co_supervision_interest" BOOLEAN NOT NULL DEFAULT true,
    "students_see_other_group_ideas" BOOLEAN NOT NULL DEFAULT false,
    "allow_supervisor_self_request" BOOLEAN NOT NULL DEFAULT true,
    "selection_confirmed_by" "SelectionConfirmer" NOT NULL DEFAULT 'SUPERVISOR',
    "allow_individual_participation" BOOLEAN NOT NULL DEFAULT false,
    "auto_create_solo_group" BOOLEAN NOT NULL DEFAULT true,
    "head_judge_enabled" BOOLEAN NOT NULL DEFAULT false,
    "require_overall_comment" BOOLEAN NOT NULL DEFAULT true,
    "availability_required_from" "AvailabilityRequirement" NOT NULL DEFAULT 'EVALUATORS_ONLY',
    "grading_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ca_contribution_percent" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cpi_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_panel_rules" (
    "id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "role" "PanelRole" NOT NULL,
    "min_required" INTEGER NOT NULL DEFAULT 0,
    "max_allowed" INTEGER,
    "weight_percent" DOUBLE PRECISION,
    "mark_counting" "MarkCounting" NOT NULL DEFAULT 'COUNTED',
    "open_to_all" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "stage_panel_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_panelists" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organization" TEXT,
    "token_hash" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "invited_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_panelists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_panelists" (
    "id" TEXT NOT NULL,
    "evaluation_session_id" TEXT NOT NULL,
    "role" "PanelRole" NOT NULL,
    "user_id" TEXT,
    "lecturer_id" TEXT,
    "cpi_evaluator_id" TEXT,
    "guest_panelist_id" TEXT,
    "weight_percent" DOUBLE PRECISION,
    "mark_counting" "MarkCounting",
    "added_by_id" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_panelists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_evaluations" (
    "id" TEXT NOT NULL,
    "session_panelist_id" TEXT NOT NULL,
    "overall_comment" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pooled_share_decisions" (
    "id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "share_percent" DOUBLE PRECISION NOT NULL,
    "scorer_limit" INTEGER,
    "reason" TEXT NOT NULL,
    "decided_by_id" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pooled_share_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_reviews" (
    "id" TEXT NOT NULL,
    "evaluation_session_id" TEXT NOT NULL,
    "reviewer_user_id" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "reason" TEXT,
    "correction_panelist_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cpi_policies_course_instance_id_key" ON "cpi_policies"("course_instance_id");
CREATE UNIQUE INDEX "stage_panel_rules_evaluation_stage_id_role_key" ON "stage_panel_rules"("evaluation_stage_id", "role");
CREATE UNIQUE INDEX "guest_panelists_token_hash_key" ON "guest_panelists"("token_hash");
CREATE INDEX "guest_panelists_course_instance_id_idx" ON "guest_panelists"("course_instance_id");
CREATE INDEX "session_panelists_evaluation_session_id_idx" ON "session_panelists"("evaluation_session_id");
CREATE UNIQUE INDEX "session_panelists_evaluation_session_id_user_id_key" ON "session_panelists"("evaluation_session_id", "user_id");
CREATE UNIQUE INDEX "session_panelists_evaluation_session_id_guest_panelist_id_key" ON "session_panelists"("evaluation_session_id", "guest_panelist_id");
CREATE UNIQUE INDEX "session_evaluations_session_panelist_id_key" ON "session_evaluations"("session_panelist_id");
CREATE INDEX "pooled_share_decisions_evaluation_stage_id_idx" ON "pooled_share_decisions"("evaluation_stage_id");
CREATE UNIQUE INDEX "session_reviews_evaluation_session_id_key" ON "session_reviews"("evaluation_session_id");

-- AddForeignKey
ALTER TABLE "cpi_policies" ADD CONSTRAINT "cpi_policies_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_panel_rules" ADD CONSTRAINT "stage_panel_rules_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guest_panelists" ADD CONSTRAINT "guest_panelists_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guest_panelists" ADD CONSTRAINT "guest_panelists_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "session_panelists" ADD CONSTRAINT "session_panelists_evaluation_session_id_fkey" FOREIGN KEY ("evaluation_session_id") REFERENCES "evaluation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_panelists" ADD CONSTRAINT "session_panelists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_panelists" ADD CONSTRAINT "session_panelists_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_panelists" ADD CONSTRAINT "session_panelists_cpi_evaluator_id_fkey" FOREIGN KEY ("cpi_evaluator_id") REFERENCES "cpi_evaluators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_panelists" ADD CONSTRAINT "session_panelists_guest_panelist_id_fkey" FOREIGN KEY ("guest_panelist_id") REFERENCES "guest_panelists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_panelists" ADD CONSTRAINT "session_panelists_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "session_evaluations" ADD CONSTRAINT "session_evaluations_session_panelist_id_fkey" FOREIGN KEY ("session_panelist_id") REFERENCES "session_panelists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pooled_share_decisions" ADD CONSTRAINT "pooled_share_decisions_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pooled_share_decisions" ADD CONSTRAINT "pooled_share_decisions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "session_reviews" ADD CONSTRAINT "session_reviews_evaluation_session_id_fkey" FOREIGN KEY ("evaluation_session_id") REFERENCES "evaluation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_reviews" ADD CONSTRAINT "session_reviews_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one policy per existing CPI, reproducing the behaviour its mode used
-- to hard-code. COALESCE matters — mode is nullable, and a null-mode CPI could
-- previously post no ideas at all, so both idea flags stay false for it (the
-- coordinator can now open them from the policy, which was impossible before).
-- Two settings deliberately differ from the new defaults so courses already
-- running do not change under their users' feet:
--   student_ideas_leader_only = false  (any member could post before)
--   require_overall_comment   = false  (existing sessions have no overall comment)
INSERT INTO "cpi_policies" (
    "id", "course_instance_id",
    "allow_supervisor_ideas", "allow_coordinator_ideas", "require_student_idea_approval",
    "student_ideas_leader_only", "interest_enabled", "selection_confirmed_by",
    "head_judge_enabled", "require_overall_comment", "updated_at"
)
SELECT
    gen_random_uuid()::text,
    ci."id",
    COALESCE(ci."mode" = 'SUPERVISOR_LED', false),
    COALESCE(ci."mode" = 'COORDINATOR_MANAGED', false),
    COALESCE(ci."mode" = 'COORDINATOR_MANAGED', false),
    false,
    COALESCE(ci."mode" = 'SUPERVISOR_LED', false),
    CASE WHEN ci."mode" = 'COORDINATOR_MANAGED' THEN 'COORDINATOR'::"SelectionConfirmer" ELSE 'SUPERVISOR'::"SelectionConfirmer" END,
    true,
    false,
    CURRENT_TIMESTAMP
FROM "course_instances" ci;

-- Backfill: turn each stage's evaluatorsRequired into an EVALUATOR panel rule,
-- so the count that used to gate completion keeps gating it.
INSERT INTO "stage_panel_rules" ("id", "evaluation_stage_id", "role", "min_required")
SELECT gen_random_uuid()::text, es."id", 'EVALUATOR'::"PanelRole", es."evaluators_required"
FROM "evaluation_stages" es;

-- AlterTable
ALTER TABLE "evaluation_stages"
    ADD COLUMN "panel_score_visibility" "PanelScoreVisibility" NOT NULL DEFAULT 'ISOLATED',
    ADD COLUMN "pooled_share_percent" DOUBLE PRECISION,
    ADD COLUMN "pooled_scorer_limit" INTEGER;

ALTER TABLE "rubric_criteria" ADD COLUMN "level" "CriterionLevel" NOT NULL DEFAULT 'GROUP';

-- Backfill: give every existing session a panel. Seats come from the stage's
-- assigned evaluators, plus anyone who actually scored (in case they were
-- unassigned afterwards), plus the CPI's Head Judge.
INSERT INTO "session_panelists" ("id", "evaluation_session_id", "role", "user_id", "lecturer_id", "cpi_evaluator_id")
SELECT DISTINCT ON (sub."session_id", l."user_id")
    gen_random_uuid()::text, sub."session_id", 'EVALUATOR'::"PanelRole", l."user_id", l."id", sub."cpi_evaluator_id"
FROM (
    SELECT es."id" AS "session_id", se."cpi_evaluator_id" AS "cpi_evaluator_id"
    FROM "evaluation_sessions" es
    JOIN "stage_evaluators" se ON se."evaluation_stage_id" = es."evaluation_stage_id"
    UNION
    SELECT rs."evaluation_session_id", rs."cpi_evaluator_id"
    FROM "rubric_scores" rs
) sub
JOIN "cpi_evaluators" ce ON ce."id" = sub."cpi_evaluator_id"
JOIN "lecturers" l ON l."id" = ce."lecturer_id";

INSERT INTO "session_panelists" ("id", "evaluation_session_id", "role", "user_id", "lecturer_id", "cpi_evaluator_id")
SELECT gen_random_uuid()::text, es."id", 'HEAD_JUDGE'::"PanelRole", l."user_id", l."id", ce."id"
FROM "evaluation_sessions" es
JOIN "cpi_evaluators" ce ON ce."course_instance_id" = es."course_instance_id" AND ce."is_head_judge" = true
JOIN "lecturers" l ON l."id" = ce."lecturer_id"
ON CONFLICT ("evaluation_session_id", "user_id") DO NOTHING;

-- AlterTable: rubric_scores moves from an evaluator reference to a panel seat.
ALTER TABLE "rubric_scores" ADD COLUMN "session_panelist_id" TEXT;
ALTER TABLE "rubric_scores" ADD COLUMN "student_id" TEXT;

UPDATE "rubric_scores" rs
SET "session_panelist_id" = sp."id"
FROM "session_panelists" sp
WHERE sp."evaluation_session_id" = rs."evaluation_session_id"
  AND sp."cpi_evaluator_id" = rs."cpi_evaluator_id";

-- Any score whose panel seat could not be resolved would silently lose its
-- author, so fail loudly instead of dropping it.
DO $$
DECLARE orphaned INTEGER;
BEGIN
    SELECT COUNT(*) INTO orphaned FROM "rubric_scores" WHERE "session_panelist_id" IS NULL;
    IF orphaned > 0 THEN
        RAISE EXCEPTION 'Cannot migrate: % rubric_scores row(s) have no matching panel seat', orphaned;
    END IF;
END $$;

ALTER TABLE "rubric_scores" ALTER COLUMN "session_panelist_id" SET NOT NULL;

-- Migrate Head Judge reviews into the generalised session_reviews.
INSERT INTO "session_reviews" ("id", "evaluation_session_id", "reviewer_user_id", "decision", "reason", "correction_panelist_id", "created_at", "updated_at")
SELECT
    hjr."id",
    hjr."evaluation_session_id",
    l."user_id",
    hjr."decision"::text::"ReviewDecision",
    hjr."reason",
    sp."id",
    hjr."created_at",
    hjr."updated_at"
FROM "head_judge_reviews" hjr
JOIN "cpi_evaluators" ce ON ce."id" = hjr."head_judge_cpi_evaluator_id"
JOIN "lecturers" l ON l."id" = ce."lecturer_id"
LEFT JOIN "session_panelists" sp
       ON sp."evaluation_session_id" = hjr."evaluation_session_id"
      AND sp."cpi_evaluator_id" = hjr."correction_evaluator_id";

-- DropForeignKey / DropIndex / DropColumn — only now that everything is copied.
ALTER TABLE "head_judge_reviews" DROP CONSTRAINT "head_judge_reviews_evaluation_session_id_fkey";
ALTER TABLE "rubric_scores" DROP CONSTRAINT "rubric_scores_cpi_evaluator_id_fkey";
DROP INDEX "rubric_scores_evaluation_session_id_cpi_evaluator_id_rubric_key";
ALTER TABLE "rubric_scores" DROP COLUMN "cpi_evaluator_id";
ALTER TABLE "evaluation_stages" DROP COLUMN "evaluators_required";
DROP TABLE "head_judge_reviews";
DROP TYPE "HeadJudgeDecision";

-- CreateIndex
-- Two partial indexes rather than one compound unique: Postgres treats NULLs as
-- distinct, so a plain unique over a nullable student_id would let the same
-- panelist score one GROUP criterion twice.
CREATE INDEX "rubric_scores_session_panelist_id_idx" ON "rubric_scores"("session_panelist_id");
CREATE UNIQUE INDEX "rubric_scores_group_criterion_key"
    ON "rubric_scores" ("evaluation_session_id", "session_panelist_id", "rubric_criterion_id")
    WHERE "student_id" IS NULL;
CREATE UNIQUE INDEX "rubric_scores_individual_criterion_key"
    ON "rubric_scores" ("evaluation_session_id", "session_panelist_id", "rubric_criterion_id", "student_id")
    WHERE "student_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "rubric_scores" ADD CONSTRAINT "rubric_scores_session_panelist_id_fkey" FOREIGN KEY ("session_panelist_id") REFERENCES "session_panelists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rubric_scores" ADD CONSTRAINT "rubric_scores_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
