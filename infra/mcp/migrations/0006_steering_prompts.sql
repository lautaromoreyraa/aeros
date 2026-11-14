-- The prompts that changed the direction of the product, each with the
-- situation it answered and the decision taken. Lautaro and David both
-- prompt, so the person who wrote the prompt is stored apart from the
-- verified identity and the assistant that wrote the row: the three can
-- differ (one service token, several assistants).

CREATE TABLE steering_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompted_by TEXT NOT NULL CHECK (prompted_by IN ('lautaro', 'david')),
  author TEXT NOT NULL,
  agent TEXT NOT NULL,
  category TEXT NOT NULL,
  -- 3 changed the direction of the product, 2 shaped a feature or a process, 1 refined.
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 3),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  situation TEXT NOT NULL,
  decision TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX steering_prompts_occurred_at ON steering_prompts (occurred_at, id);
