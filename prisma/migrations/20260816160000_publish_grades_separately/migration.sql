-- Releasing the grade is its own decision, taken later than releasing marks:
-- marks go out during the semester, the grade only once everything is in.
--
-- Existing rows default to false rather than inheriting publishMarks — a course
-- that already released marks has not thereby released a grade, and silently
-- revealing one would be the opposite of what this column is for.
ALTER TABLE "mark_publications" ADD COLUMN "publish_grades" BOOLEAN NOT NULL DEFAULT false;
