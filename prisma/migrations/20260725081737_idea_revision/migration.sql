-- AlterEnum
ALTER TYPE "IdeaApprovalStatus" ADD VALUE 'REVISION_REQUESTED';

-- AlterTable
ALTER TABLE "project_ideas" ADD COLUMN     "revision_note" TEXT;
