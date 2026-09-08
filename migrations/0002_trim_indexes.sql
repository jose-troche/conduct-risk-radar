-- Cut the write cost of `complaints` by dropping redundant indexes.
--
-- D1 meters index writes as row writes. The complaints table carried four
-- secondary indexes, so every upserted complaint cost five row-writes against
-- the free tier's 100k/day, and a 160-day backfill of ~146k rows spent ~730k.
-- That is what actually exhausted the quota, not the row count.
--
-- Every analytic query in detect/queries.ts filters on a date_received range
-- first and then groups, so one composite index leading with date_received
-- serves them; the drivers query additionally needs cell_key, which the same
-- composite covers as its second column. The remaining lookups are by
-- complaint_id, which the primary key already handles.
--
-- Four secondary indexes become one: 5 row-writes per complaint become 2.

DROP INDEX IF EXISTS idx_complaints_date;
DROP INDEX IF EXISTS idx_complaints_cell;
DROP INDEX IF EXISTS idx_complaints_company;
DROP INDEX IF EXISTS idx_complaints_prodissue;

CREATE INDEX IF NOT EXISTS idx_complaints_window
  ON complaints(date_received, cell_key);
