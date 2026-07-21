-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'SYSTEM_ADMIN', 'COURSE_COORDINATOR', 'SUPERVISOR', 'EVALUATOR', 'HEAD_JUDGE', 'STUDENT');

-- CreateEnum
CREATE TYPE "LecturerApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CpiMode" AS ENUM ('SUPERVISOR_LED', 'COORDINATOR_MANAGED');

-- CreateEnum
CREATE TYPE "CpiProjectType" AS ENUM ('FYP', 'DATA_MANAGEMENT', 'HPC', 'INNOVATION_CHALLENGE');

-- CreateEnum
CREATE TYPE "CpiPhase" AS ENUM ('STUDENT_REGISTRATION', 'SUPERVISOR_ADDITION', 'IDEA_ANNOUNCEMENT', 'PROJECT_SELECTION', 'PROJECT_REGISTRATION', 'EVALUATION_CONFIG', 'PROPOSAL_SUBMISSION', 'AVAILABILITY_SUBMISSION', 'EVALUATION_EXECUTION', 'FINAL_SUBMISSION');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "force_password_change" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "provisioning_status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lecturers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "self_registered" BOOLEAN NOT NULL DEFAULT false,
    "approval_status" "LecturerApprovalStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "lecturers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_instances" (
    "id" TEXT NOT NULL,
    "project_type" "CpiProjectType" NOT NULL,
    "department" TEXT NOT NULL,
    "academic_year" TEXT NOT NULL,
    "mode" "CpiMode",
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cpi_timelines" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "phase" "CpiPhase" NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cpi_timelines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_key" ON "students"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_student_id_key" ON "students"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "lecturers_user_id_key" ON "lecturers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "cpi_timelines_course_instance_id_phase_key" ON "cpi_timelines"("course_instance_id", "phase");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lecturers" ADD CONSTRAINT "lecturers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_instances" ADD CONSTRAINT "course_instances_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cpi_timelines" ADD CONSTRAINT "cpi_timelines_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
