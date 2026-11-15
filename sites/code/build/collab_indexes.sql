-- Collaboration side (sites/code/collab/) additions to base.db: indexes for the issue / MR
-- lists and tables GitLab has that the export did not need (label priorities, topics).
-- Idempotent; applied by `build.sh collab` after `assemble` (and once by hand to an existing
-- base.db -- never while servers have it open). Documented in docs/NOTES-code.md.

-- project issue / MR lists: state=all sorted by created/updated, state=X sorted by updated
CREATE INDEX IF NOT EXISTS issues_project_created ON issues(project_id, created_at);
CREATE INDEX IF NOT EXISTS issues_project_updated ON issues(project_id, updated_at);
CREATE INDEX IF NOT EXISTS issues_project_state_updated ON issues(project_id, state, updated_at);
CREATE INDEX IF NOT EXISTS mrs_project_created ON merge_requests(project_id, created_at);
CREATE INDEX IF NOT EXISTS mrs_project_updated ON merge_requests(project_id, updated_at);
CREATE INDEX IF NOT EXISTS mrs_project_state_updated ON merge_requests(project_id, state, updated_at);
-- milestone pages / progress for MRs
CREATE INDEX IF NOT EXISTS mrs_milestone ON merge_requests(milestone_id);

-- GitLab's "prioritized labels" (Labels page star; issue sort "Label priority").
-- priority: smaller = higher; a label without a row is not prioritized.
CREATE TABLE IF NOT EXISTS label_priorities (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  priority INTEGER NOT NULL,
  created_at TEXT,
  PRIMARY KEY (project_id, label_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS label_priorities_label ON label_priorities(label_id);

-- project topics (Settings > General "Topics"); the site falls back to per-tenant temp tables
-- when base.db predates this step
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS project_topics (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  PRIMARY KEY (project_id, topic_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS project_topics_topic ON project_topics(topic_id);

ANALYZE issues;
ANALYZE merge_requests;
