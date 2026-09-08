-- Record which reviewer a label set came from.
--
-- Agreement is agreement with one reviewer, so a run that mixes reviewers is
-- measuring something nobody asked for. It matters more once seed labels exist:
-- a seed label is a stated rubric, not a human judgement, and an eval run that
-- silently blends the two would report a number that means neither thing.

ALTER TABLE eval_runs ADD COLUMN analyst_filter TEXT;
ALTER TABLE eval_runs ADD COLUMN reviewers_json TEXT NOT NULL DEFAULT '[]';
