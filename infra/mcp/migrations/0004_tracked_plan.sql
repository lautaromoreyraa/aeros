-- The project plan now lives in the repository, in English.

INSERT INTO conventions (key, value, updated_by) VALUES
  ('documentation',
   'PLAN.md at the repository root is the shared project plan (problem, brief objectives, approach, architecture, status, submission checklist). ' ||
   'Keep it in English and update its status table in the same branch as the change it describes. ' ||
   'Assistant instruction files (CLAUDE.md, AGENTS.md, .claude/) stay ignored; notes, decisions and progress go to this server.',
   'seed')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_by = excluded.updated_by,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
