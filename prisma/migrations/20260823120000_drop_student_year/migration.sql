-- Year of study was never read, and went stale as students advanced.
-- Batch is the durable field and already decides course visibility.
ALTER TABLE "students" DROP COLUMN "year";
