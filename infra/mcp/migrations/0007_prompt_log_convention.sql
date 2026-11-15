-- How every assistant keeps the prompts that steer the product. It is its own
-- convention, not an edit of coordination, so it does not collide with the
-- task-closing rule that is rewritten in that row.

INSERT INTO conventions (key, value, updated_by) VALUES
  ('prompt_log',
   'When a prompt from Lautaro or David changes what we build or how (scope, priority, architecture, data, process, quality, a constraint or a correction), call record_steering_prompt right after acting on it, in the same task: ' ||
   'their own words trimmed to the instruction that mattered, the situation it answered, the decision taken and its impact. ' ||
   'prompted_by is the person who wrote it, not the assistant. importance 3 redirected the product, 2 shaped a feature or a process, 1 refined something. ' ||
   'Log what changed the course, a handful per session, not every message. Never include credentials or other people''s personal data; the server rejects credentials. ' ||
   'steering_study turns the log into the document for the final presentation and for declaring how AI was used in the submission.',
   'seed')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_by = excluded.updated_by,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
