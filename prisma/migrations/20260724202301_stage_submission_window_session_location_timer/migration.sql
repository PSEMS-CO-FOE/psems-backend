-- AlterTable
ALTER TABLE "evaluation_sessions" ADD COLUMN     "location" TEXT,
ADD COLUMN     "presentation_duration_seconds" INTEGER;

-- AlterTable
ALTER TABLE "evaluation_stages" ADD COLUMN     "submission_window_end" TIMESTAMP(3),
ADD COLUMN     "submission_window_start" TIMESTAMP(3);
