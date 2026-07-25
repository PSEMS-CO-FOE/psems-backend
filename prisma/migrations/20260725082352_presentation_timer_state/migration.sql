-- AlterTable
ALTER TABLE "evaluation_sessions" ADD COLUMN     "timer_accumulated_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timer_running" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timer_started_at" TIMESTAMP(3);
