-- Convert project_type from the CpiProjectType enum to free text, preserving
-- existing values, then drop the now-unused enum.
ALTER TABLE "course_instances"
  ALTER COLUMN "project_type" TYPE TEXT USING ("project_type"::text);

-- DropEnum
DROP TYPE "CpiProjectType";
