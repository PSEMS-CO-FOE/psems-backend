-- CreateEnum
CREATE TYPE "EoiType" AS ENUM ('GROUP_INTEREST', 'SEEKING_SUPERVISOR', 'SUPERVISOR_WILLING');

-- CreateEnum
CREATE TYPE "SelectionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "interest_expressions" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "idea_id" TEXT NOT NULL,
    "type" "EoiType" NOT NULL,
    "group_id" TEXT,
    "supervisor_lecturer_id" TEXT,
    "rank" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interest_expressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_selections" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "idea_id" TEXT NOT NULL,
    "supervisor_lecturer_id" TEXT,
    "status" "SelectionStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "project_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interest_expressions_course_instance_id_idx" ON "interest_expressions"("course_instance_id");

-- CreateIndex
CREATE INDEX "interest_expressions_idea_id_idx" ON "interest_expressions"("idea_id");

-- CreateIndex
CREATE UNIQUE INDEX "interest_expressions_group_id_idea_id_type_key" ON "interest_expressions"("group_id", "idea_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "interest_expressions_supervisor_lecturer_id_idea_id_type_key" ON "interest_expressions"("supervisor_lecturer_id", "idea_id", "type");

-- CreateIndex
CREATE INDEX "project_selections_course_instance_id_idx" ON "project_selections"("course_instance_id");

-- CreateIndex
CREATE INDEX "project_selections_group_id_idx" ON "project_selections"("group_id");

-- AddForeignKey
ALTER TABLE "interest_expressions" ADD CONSTRAINT "interest_expressions_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interest_expressions" ADD CONSTRAINT "interest_expressions_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "project_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interest_expressions" ADD CONSTRAINT "interest_expressions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interest_expressions" ADD CONSTRAINT "interest_expressions_supervisor_lecturer_id_fkey" FOREIGN KEY ("supervisor_lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_idea_id_fkey" FOREIGN KEY ("idea_id") REFERENCES "project_ideas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_selections" ADD CONSTRAINT "project_selections_supervisor_lecturer_id_fkey" FOREIGN KEY ("supervisor_lecturer_id") REFERENCES "lecturers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
