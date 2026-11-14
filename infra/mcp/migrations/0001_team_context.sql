-- Shared working memory for every agent connected to the server.

CREATE TABLE progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  agent TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX progress_created_at ON progress (created_at DESC);

-- One row per claimed task; releasing deletes it. The primary key is what
-- stops two agents from working on the same files at once.
CREATE TABLE tasks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  agent TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE conventions (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO conventions (key, value, updated_by) VALUES
  ('language', 'Everything in English: code, identifiers, comments, commits, branch names and UI copy.', 'seed'),
  ('branches', 'One branch per change, feature/<kebab-case-description>, cut from develop and merged back with --no-ff after review. Never commit to main or develop directly.', 'seed'),
  ('commits', 'Imperative subject up to 72 characters, blank line, body wrapped at 72 explaining why. One logical change that builds and passes tests. No AI attribution lines or trailers.', 'seed'),
  ('documentation', 'No Markdown files are tracked (*.md is ignored). Shared notes, decisions and status live in this server.', 'seed'),
  ('data', 'FIRMS downloads and derived tables are never committed; the pipeline rebuilds them. The UI shows processed views, never raw FIRMS rows.', 'seed'),
  ('layout', 'model/ Python harmonization pipeline; web/ React + Vite + TypeScript client; infra/ AWS CDK stacks and this MCP server.', 'seed'),
  ('coordination', 'Claim a task before touching its files and release it when done. Log progress after every meaningful step.', 'seed');
