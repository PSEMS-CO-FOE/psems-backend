-- The availability grid, per-session slot length, and the multi-segment
-- presentation timer.
--
-- Written by hand: the generated script would have deleted evaluator_availability
-- and its rows, so they are copied into the new grid before the table is dropped.

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'TENTATIVE', 'UNAVAILABLE');
CREATE TYPE "SegmentTimeliness" AS ENUM ('ON_TIME', 'OVERTIME', 'UNDER');

-- AlterTable
ALTER TABLE "evaluation_sessions"
    ADD COLUMN "allocated_minutes" INTEGER,
    ADD COLUMN "current_segment_index" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "availability_templates" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "availability_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "availability_template_slots" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "availability_template_slots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "panel_availability" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "template_slot_id" TEXT NOT NULL,
    "slot_date" DATE NOT NULL,
    "status" "AvailabilityStatus" NOT NULL,
    "note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "panel_availability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "timer_segment_templates" (
    "id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_seconds" INTEGER NOT NULL,
    "order_index" INTEGER NOT NULL,

    CONSTRAINT "timer_segment_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "session_timer_segments" (
    "id" TEXT NOT NULL,
    "evaluation_session_id" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "target_seconds" INTEGER NOT NULL,
    "accumulated_seconds" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "running" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "overran_seconds" INTEGER NOT NULL DEFAULT 0,
    "timeliness" "SegmentTimeliness",
    "timeliness_manual" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "session_timer_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "availability_templates_course_instance_id_key" ON "availability_templates"("course_instance_id");
CREATE INDEX "availability_template_slots_template_id_idx" ON "availability_template_slots"("template_id");
CREATE INDEX "panel_availability_course_instance_id_idx" ON "panel_availability"("course_instance_id");
CREATE UNIQUE INDEX "panel_availability_lecturer_id_slot_date_template_slot_id_key" ON "panel_availability"("lecturer_id", "slot_date", "template_slot_id");
CREATE INDEX "timer_segment_templates_evaluation_stage_id_idx" ON "timer_segment_templates"("evaluation_stage_id");
CREATE UNIQUE INDEX "session_timer_segments_evaluation_session_id_order_index_key" ON "session_timer_segments"("evaluation_session_id", "order_index");

-- AddForeignKey
ALTER TABLE "availability_templates" ADD CONSTRAINT "availability_templates_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "availability_template_slots" ADD CONSTRAINT "availability_template_slots_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "availability_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "panel_availability" ADD CONSTRAINT "panel_availability_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "panel_availability" ADD CONSTRAINT "panel_availability_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "panel_availability" ADD CONSTRAINT "panel_availability_template_slot_id_fkey" FOREIGN KEY ("template_slot_id") REFERENCES "availability_template_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timer_segment_templates" ADD CONSTRAINT "timer_segment_templates_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "session_timer_segments" ADD CONSTRAINT "session_timer_segments_evaluation_session_id_fkey" FOREIGN KEY ("evaluation_session_id") REFERENCES "evaluation_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Move existing availability into the grid. Each course that has any submitted
-- slot gets one grid, covering the dates people actually offered.
INSERT INTO "availability_templates" ("id", "course_instance_id", "window_start", "window_end", "updated_at")
SELECT
    gen_random_uuid()::text,
    ea."course_instance_id",
    MIN(ea."slot_start")::date,
    MAX(ea."slot_end")::date,
    CURRENT_TIMESTAMP
FROM "evaluator_availability" ea
GROUP BY ea."course_instance_id";

-- Each different time range becomes a row in the grid. The old table had no slot
-- names, so the time range is used as the name.
INSERT INTO "availability_template_slots" ("id", "template_id", "name", "start_time", "end_time", "order_index")
SELECT
    gen_random_uuid()::text,
    t."id",
    ranges."start_time" || '–' || ranges."end_time",
    ranges."start_time",
    ranges."end_time",
    ROW_NUMBER() OVER (PARTITION BY ranges."course_instance_id" ORDER BY ranges."start_time") - 1
FROM (
    SELECT DISTINCT
        ea."course_instance_id",
        to_char(ea."slot_start", 'HH24:MI') AS "start_time",
        to_char(ea."slot_end", 'HH24:MI') AS "end_time"
    FROM "evaluator_availability" ea
) ranges
JOIN "availability_templates" t ON t."course_instance_id" = ranges."course_instance_id";

-- Every old row meant "I am free then", so each becomes AVAILABLE. The lecturer is
-- looked up through cpi_evaluators, the extra step the new table removes.
INSERT INTO "panel_availability" ("id", "course_instance_id", "lecturer_id", "template_slot_id", "slot_date", "status", "updated_at")
SELECT DISTINCT ON (ce."lecturer_id", ea."slot_start"::date, s."id")
    gen_random_uuid()::text,
    ea."course_instance_id",
    ce."lecturer_id",
    s."id",
    ea."slot_start"::date,
    'AVAILABLE'::"AvailabilityStatus",
    CURRENT_TIMESTAMP
FROM "evaluator_availability" ea
JOIN "cpi_evaluators" ce ON ce."id" = ea."cpi_evaluator_id"
JOIN "availability_templates" t ON t."course_instance_id" = ea."course_instance_id"
JOIN "availability_template_slots" s
    ON s."template_id" = t."id"
    AND s."start_time" = to_char(ea."slot_start", 'HH24:MI')
    AND s."end_time" = to_char(ea."slot_end", 'HH24:MI');

-- DropTable
DROP TABLE "evaluator_availability";
