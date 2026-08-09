-- Drop the OBSERVER panel role.
--
-- It was added as the "attends without marking" seat, but the department has no
-- such person: whoever runs the room is an evaluator, and the real "present but
-- doesn't count" mechanism is MarkCounting.ADVISORY, which keeps the mark on
-- record instead of discarding it.
--
-- Postgres cannot remove an enum value in place, so the type is rebuilt. Fail
-- loudly rather than silently rewriting anyone's seat if a row still uses it.
DO $$
DECLARE observers INTEGER;
BEGIN
    SELECT COUNT(*) INTO observers FROM "session_panelists" WHERE "role" = 'OBSERVER';
    IF observers > 0 THEN
        RAISE EXCEPTION 'Cannot migrate: % session_panelists row(s) still hold the OBSERVER role', observers;
    END IF;
    SELECT COUNT(*) INTO observers FROM "stage_panel_rules" WHERE "role" = 'OBSERVER';
    IF observers > 0 THEN
        RAISE EXCEPTION 'Cannot migrate: % stage_panel_rules row(s) still reference the OBSERVER role', observers;
    END IF;
END $$;

CREATE TYPE "PanelRole_new" AS ENUM ('COORDINATOR', 'SUPERVISOR', 'CO_SUPERVISOR', 'SENIOR_EVALUATOR', 'EVALUATOR', 'JUNIOR_EVALUATOR', 'HEAD_JUDGE');

ALTER TABLE "session_panelists" ALTER COLUMN "role" TYPE "PanelRole_new" USING ("role"::text::"PanelRole_new");
ALTER TABLE "stage_panel_rules" ALTER COLUMN "role" TYPE "PanelRole_new" USING ("role"::text::"PanelRole_new");

ALTER TYPE "PanelRole" RENAME TO "PanelRole_old";
ALTER TYPE "PanelRole_new" RENAME TO "PanelRole";
DROP TYPE "PanelRole_old";
