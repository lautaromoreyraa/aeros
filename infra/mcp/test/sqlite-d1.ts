// Minimal D1-shaped adapter over node:sqlite, so the store runs against the
// real migration SQL in tests without a Workers runtime.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Database, Statement } from "../src/store";

class SqliteStatement implements Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.values as never[])) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null;
  }

  async run(): Promise<unknown> {
    return this.db.prepare(this.sql).run(...(this.values as never[]));
  }
}

export function migratedDatabase(): Database {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url).href);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${dir}/${file}`, "utf8"));
  }
  return { prepare: (sql: string) => new SqliteStatement(db, sql) };
}
