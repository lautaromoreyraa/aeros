// Persistence for the shared context. Written against the subset of the D1
// API it uses, so tests can run it on an in-process SQLite database.

import { findSecrets } from "./secrets";

export interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
}

export interface Actor {
  author: string;
  agent: string;
}

export interface ProgressEntry {
  id: number;
  author: string;
  agent: string;
  text: string;
  created_at: string;
}

export interface Task {
  name: string;
  owner: string;
  agent: string;
  note: string;
  claimed_at: string;
}

export interface Decision {
  id: number;
  title: string;
  body: string;
  author: string;
  created_at: string;
}

export interface Convention {
  key: string;
  value: string;
  updated_by: string;
  updated_at: string;
}

export const PROMPTERS = ["lautaro", "david"] as const;
export type Prompter = (typeof PROMPTERS)[number];

export const PROMPT_CATEGORIES = [
  "scope",
  "architecture",
  "data",
  "process",
  "quality",
  "security",
  "presentation",
] as const;
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export type Importance = 1 | 2 | 3;

export interface SteeringPrompt {
  id: number;
  prompted_by: Prompter;
  author: string;
  agent: string;
  category: PromptCategory;
  importance: Importance;
  title: string;
  prompt: string;
  situation: string;
  decision: string;
  impact: string;
  refs: string;
  occurred_at: string;
}

export interface NewSteeringPrompt {
  promptedBy: Prompter;
  category: PromptCategory;
  importance: Importance;
  title: string;
  prompt: string;
  situation: string;
  decision: string;
  impact?: string;
  refs?: string;
  /** For prompts recorded after the fact; defaults to now. Never in the future. */
  occurredAt?: string;
}

export interface SteeringFilter {
  promptedBy?: Prompter;
  category?: PromptCategory;
  minImportance?: Importance;
  /** ISO date or datetime: only prompts from then on. */
  since?: string;
}

/** A text field held something that looks like a credential, so nothing was stored. */
export class SecretInTextError extends Error {
  constructor(
    readonly field: string,
    readonly rules: string[],
  ) {
    super(`"${field}" looks like it contains a credential (${rules.join(", ")}); remove it and retry`);
  }
}

export class InvalidTimeError extends Error {}

const TEXT_FIELDS = ["title", "prompt", "situation", "decision", "impact", "refs"] as const;

function parsedTime(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidTimeError(`"${value}" is not a date`);
  return parsed;
}

const asStored = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

export const GIT_WORKFLOW_ORDER = [
  "coordination",
  "branches",
  "commits",
  "cleanup_before_pr",
  "sync_with_develop",
  "pull_requests",
  "merging",
  "releases",
] as const;

export class TaskConflictError extends Error {
  constructor(readonly task: Task) {
    super(`task "${task.name}" is held by ${task.owner} (${task.agent}) since ${task.claimed_at}`);
  }
}

export class Store {
  constructor(private readonly db: Database) {}

  async logProgress(actor: Actor, text: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO progress (author, agent, text) VALUES (?, ?, ?)")
      .bind(actor.author, actor.agent, text)
      .run();
  }

  async recentProgress(limit = 20): Promise<ProgressEntry[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM progress ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<ProgressEntry>();
    return results;
  }

  async tasks(): Promise<Task[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM tasks ORDER BY claimed_at")
      .all<Task>();
    return results;
  }

  async claimTask(actor: Actor, name: string, note: string): Promise<Task> {
    const current = await this.db
      .prepare("SELECT * FROM tasks WHERE name = ?")
      .bind(name)
      .first<Task>();
    if (current && current.owner !== actor.author) throw new TaskConflictError(current);
    await this.db
      .prepare(
        `INSERT INTO tasks (name, owner, agent, note) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET agent = excluded.agent, note = excluded.note`,
      )
      .bind(name, actor.author, actor.agent, note)
      .run();
    const claimed = await this.db
      .prepare("SELECT * FROM tasks WHERE name = ?")
      .bind(name)
      .first<Task>();
    return claimed as Task;
  }

  /** Releases a task the actor holds. Returns false when there was nothing to release. */
  async releaseTask(actor: Actor, name: string): Promise<boolean> {
    const current = await this.db
      .prepare("SELECT * FROM tasks WHERE name = ?")
      .bind(name)
      .first<Task>();
    if (!current) return false;
    if (current.owner !== actor.author) throw new TaskConflictError(current);
    await this.db.prepare("DELETE FROM tasks WHERE name = ?").bind(name).run();
    return true;
  }

  async recordDecision(actor: Actor, title: string, body: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO decisions (title, body, author) VALUES (?, ?, ?)")
      .bind(title, body, actor.author)
      .run();
  }

  async decisions(): Promise<Decision[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM decisions ORDER BY id")
      .all<Decision>();
    return results;
  }

  /**
   * Keeps a prompt that steered the product. Credentials are refused here and
   * not in the tool, so no caller can store one by another route.
   */
  async recordSteeringPrompt(
    actor: Actor,
    entry: NewSteeringPrompt,
    now: Date = new Date(),
  ): Promise<SteeringPrompt> {
    for (const field of TEXT_FIELDS) {
      const found = findSecrets(entry[field] ?? "");
      if (found.length) throw new SecretInTextError(field, found.map((f) => f.rule));
    }
    let occurredAt: string | null = null;
    if (entry.occurredAt) {
      const when = parsedTime(entry.occurredAt);
      if (when.getTime() > now.getTime() + 60_000) {
        throw new InvalidTimeError(`"${entry.occurredAt}" is in the future`);
      }
      occurredAt = asStored(when);
    }
    const stored = await this.db
      .prepare(
        `INSERT INTO steering_prompts
           (prompted_by, author, agent, category, importance, title, prompt, situation,
            decision, impact, refs, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
         RETURNING *`,
      )
      .bind(
        entry.promptedBy,
        actor.author,
        actor.agent,
        entry.category,
        entry.importance,
        entry.title,
        entry.prompt,
        entry.situation,
        entry.decision,
        entry.impact ?? "",
        entry.refs ?? "",
        occurredAt,
      )
      .first<SteeringPrompt>();
    return stored as SteeringPrompt;
  }

  /** Steering prompts oldest first, so they read as the story of the product. */
  async steeringPrompts(filter: SteeringFilter = {}): Promise<SteeringPrompt[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.promptedBy) {
      where.push("prompted_by = ?");
      values.push(filter.promptedBy);
    }
    if (filter.category) {
      where.push("category = ?");
      values.push(filter.category);
    }
    if (filter.minImportance) {
      where.push("importance >= ?");
      values.push(filter.minImportance);
    }
    if (filter.since) {
      where.push("occurred_at >= ?");
      values.push(asStored(parsedTime(filter.since)));
    }
    const { results } = await this.db
      .prepare(
        `SELECT * FROM steering_prompts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY occurred_at, id`,
      )
      .bind(...values)
      .all<SteeringPrompt>();
    return results;
  }

  async conventions(): Promise<Convention[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM conventions ORDER BY key")
      .all<Convention>();
    return results;
  }

  /** The git workflow conventions, in the order a change goes through them. */
  async gitWorkflow(): Promise<Convention[]> {
    const all = new Map((await this.conventions()).map((c) => [c.key, c]));
    return GIT_WORKFLOW_ORDER.flatMap((key) => {
      const convention = all.get(key);
      return convention ? [convention] : [];
    });
  }

  async setConvention(actor: Actor, key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO conventions (key, value, updated_by) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
      )
      .bind(key, value, actor.author)
      .run();
  }
}
