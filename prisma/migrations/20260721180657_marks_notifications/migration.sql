-- AlterTable
ALTER TABLE "course_instances" ADD COLUMN     "marks_published_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "final_marks" (
    "id" TEXT NOT NULL,
    "course_instance_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "evaluation_stage_id" TEXT NOT NULL,
    "stage_score_percent" DOUBLE PRECISION NOT NULL,
    "weighted_contribution" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "final_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "course_instance_id" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "final_marks_course_instance_id_idx" ON "final_marks"("course_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "final_marks_group_id_evaluation_stage_id_key" ON "final_marks"("group_id", "evaluation_stage_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_read_at_idx" ON "notifications"("recipient_user_id", "read_at");

-- AddForeignKey
ALTER TABLE "final_marks" ADD CONSTRAINT "final_marks_course_instance_id_fkey" FOREIGN KEY ("course_instance_id") REFERENCES "course_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "final_marks" ADD CONSTRAINT "final_marks_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "final_marks" ADD CONSTRAINT "final_marks_evaluation_stage_id_fkey" FOREIGN KEY ("evaluation_stage_id") REFERENCES "evaluation_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
