-- CreateEnum
CREATE TYPE "IdeaAuthorType" AS ENUM ('SUPERVISOR', 'COORDINATOR', 'STUDENT');

-- CreateEnum
CREATE TYPE "IdeaVisibility" AS ENUM ('PUBLIC_TO_STUDENTS', 'GROUP_RESTRICTED');

-- CreateEnum
CREATE TYPE "IdeaApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leader_student_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMP(3),

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_ideas" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "author_type" "IdeaAuthorType" NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "group_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "visibility" "IdeaVisibility" NOT NULL,
    "approval_status" "IdeaApprovalStatus",
    "similarity_flag" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "groups_course_instance_id_idx" ON "groups"("course_instance_id");

-- CreateIndex
CREATE INDEX "group_members_student_id_idx" ON "group_members"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_group_id_student_id_key" ON "group_members"("group_id", "student_id");

-- CreateIndex
CREATE INDEX "project_ideas_course_instance_id_idx" ON "project_ideas"("course_instance_id");

-- CreateIndex
CREATE INDEX "project_ideas_group_id_idx" ON "project_ideas"("group_id");

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_leader_student_id_fkey" FOREIGN KEY ("leader_student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ideas" ADD CONSTRAINT "project_ideas_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ideas" ADD CONSTRAINT "project_ideas_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ideas" ADD CONSTRAINT "project_ideas_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
