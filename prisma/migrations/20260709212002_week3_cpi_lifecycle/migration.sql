/*
  Warnings:

  - Added the required column `name` to the `course_instances` table without a default value. This is not possible if the table is not empty.
  - Added the required column `participation_mode` to the `course_instances` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "CpiParticipationMode" AS ENUM ('GROUP', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "course_instances" ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "participation_mode" "CpiParticipationMode" NOT NULL;

-- CreateTable
CREATE TABLE "cpi_supervisors" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "invitation_status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "cpi_supervisors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cpi_evaluators" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "lecturer_id" TEXT NOT NULL,
    "is_head_judge" BOOLEAN NOT NULL DEFAULT false,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cpi_evaluators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cpi_supervisors_course_instance_id_lecturer_id_key" ON "cpi_supervisors"("course_instance_id", "lecturer_id");

-- CreateIndex
CREATE UNIQUE INDEX "cpi_evaluators_course_instance_id_lecturer_id_key" ON "cpi_evaluators"("course_instance_id", "lecturer_id");

-- AddForeignKey
ALTER TABLE "cpi_supervisors" ADD CONSTRAINT "cpi_supervisors_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cpi_supervisors" ADD CONSTRAINT "cpi_supervisors_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cpi_evaluators" ADD CONSTRAINT "cpi_evaluators_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cpi_evaluators" ADD CONSTRAINT "cpi_evaluators_lecturer_id_fkey" FOREIGN KEY ("lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
