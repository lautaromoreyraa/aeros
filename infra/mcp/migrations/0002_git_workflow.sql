-- Git workflow shared by Lautaro and David and by every assistant working for
-- them. Two people commit in parallel, so the rules aim at one thing: each
-- feature leaves the tip of develop and returns to it, conflicts are solved by
-- the author of the branch before review, and the history reads like a team's.

INSERT INTO conventions (key, value, updated_by) VALUES
  ('branches',
   'Every change lives on its own branch feature/<kebab-case-description>, cut from the tip of develop: git switch develop && git pull --ff-only && git switch -c feature/<name>. ' ||
   'The name describes the product change (feature/burning-calendar-export), never the tool or a security measure. ' ||
   'Never commit directly to develop or main. One person (and their assistant) per branch; if a feature needs another, stack the branches.',
   'seed'),
  ('commits',
   'A commit is one complete logical change that builds and passes its tests: no "wip", no bare "fix", no mixed topics. ' ||
   'Subject: imperative, present tense, at most 72 characters, no trailing period, no type prefixes (Add burning calendar CSV export). ' ||
   'Blank line, then a body wrapped at 72 columns explaining WHY the change was made and the decision inside it, not which files changed. ' ||
   'No assistant signatures anywhere: no Co-Authored-By or session trailers, no "Generated with" lines, no robot emoji, in commits, PRs, comments or releases.',
   'seed'),
  ('sync_with_develop',
   'Before opening a PR and whenever develop moves, rebase your branch on the tip of develop: git fetch origin && git rebase origin/develop. ' ||
   'Resolve conflicts in your own branch, rerun the tests, then git push --force-with-lease (only on your own feature branch). ' ||
   'Never merge develop into a feature branch, never rebase or force-push develop or main.',
   'seed'),
  ('cleanup_before_pr',
   'Fixes to commits not yet merged are folded in before the PR: git commit --fixup <sha> then git rebase -i --autosquash origin/develop, or reword the message. ' ||
   'What is already on develop or main is never rewritten.',
   'seed'),
  ('pull_requests',
   'Every feature enters develop through a PR opened by its author, with a short spec of what it does and how it was verified. ' ||
   'The PR is merged only with Lautaro''s explicit approval and only when verification (lint, types, tests, build) is green. ' ||
   'If verification fails, fix it on the same branch.',
   'seed'),
  ('merging',
   'Merges are done locally with a merge commit, never with the GitHub button or gh pr merge (they add GitHub as committer): ' ||
   'git switch develop && git pull --ff-only && git merge --no-ff feature/<name> && git push origin develop. GitHub then marks the PR as merged. ' ||
   'Afterwards delete the branch locally and on GitHub: git branch -d feature/<name> && git push origin --delete feature/<name>.',
   'seed'),
  ('releases',
   'Production is main. Lautaro decides when develop ships: a PR from develop to main, merged with --no-ff, and an annotated semver tag on the merge (v1.0.0 first; minor by default, patch for fixes only, major when the API contract changes) listing the commits that ship.',
   'seed'),
  ('coordination',
   'Before touching files: project_status, then claim_task with the area (e.g. web/src/components/map). Release it when the branch is merged or abandoned. ' ||
   'Log progress after every meaningful step with log_progress, naming the branch. Record decisions with record_decision instead of writing notes in the repo.',
   'seed'),
  ('team',
   'Lautaro (backend, infra, model) works with Claude; David works with Devin (Opus) and Grok. Both push feature branches to github.com/lautaromoreyraa/aeros.',
   'seed')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_by = excluded.updated_by,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
