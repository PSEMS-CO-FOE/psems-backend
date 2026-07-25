-- AlterTable
ALTER TABLE "evaluation_stages" ADD COLUMN     "execution_window_end" TIMESTAMP(3),
ADD COLUMN     "execution_window_start" TIMESTAMP(3);
