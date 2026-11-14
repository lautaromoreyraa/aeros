-- One claimed task is one work-unit commit and one push of that commit.
-- Gentleman's orchestrator already closes each task with its own commit and
-- leaves the push to the user. This team makes that push part of closing the
-- task, so the other assistant can see the boundary on the feature branch.

INSERT INTO conventions (key, value, updated_by) VALUES
  ('task_pushes',
   'Gentleman''s orchestrator runs one task at a time and closes each task with its own work-unit commit: one deliverable behavior, the tests and docs that verify it, and a history a reviewer can read commit by commit. This team uses that same boundary for pushes. Finish the claimed task, commit it, and push that commit to its feature branch before starting the next task. Do not batch several tasks into one push, and do not split one task into a push per file type. ' ||
   'The commit stays in this repo''s voice: imperative present-tense subject, no type prefix, body explaining why, no assistant trailer. Branch first from the tip of develop when you are on develop or main. First push of the branch: git push -u origin HEAD. Further task commits: git push. After a rebase onto origin/develop: git push --force-with-lease, and only on your own feature branch. ' ||
   'Never push, rebase, or force-push develop or main. Never push work for a task you have not claimed. Name the branch and the commit in log_progress. A pull request and the merge to develop still wait for Lautaro''s approval and stay on the merging rule; this rule authorizes only the feature-branch push of a finished claimed task.',
   'seed'),
  ('coordination',
   'Before touching files: project_status, then claim_task with the area (e.g. web/src/components/map). Release it when the branch is merged or abandoned. ' ||
   'Log progress after every meaningful step with log_progress, naming the branch. Record decisions with record_decision instead of writing notes in the repo. ' ||
   'Each claimed task then closes as its own push: one work-unit commit on the feature branch, then push that commit before the next task, as task_pushes describes. Never batch several tasks into one push, and never push develop or main.',
   'seed')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_by = excluded.updated_by,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
