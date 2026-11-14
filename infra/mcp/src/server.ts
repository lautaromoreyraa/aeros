// MCP tools shared by every agent on the team (Claude, Devin, Grok).
// The author of every write comes from the verified Access identity, never
// from tool arguments, so one agent cannot write in another's name.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Identity } from "./access";
import { type PipelineData, unusualMonths } from "./data";
import { type Actor, type Store, TaskConflictError } from "./store";

const agentArg = z
  .string()
  .max(40)
  .optional()
  .describe("Which assistant is calling, e.g. claude, devin, grok.");

function text(value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildServer(store: Store, data: PipelineData, identity: Identity): McpServer {
  const server = new McpServer({ name: "aeros-team-context", version: "0.1.0" });
  const actor = (agent?: string): Actor => ({
    author: identity.author,
    agent: agent?.trim() || "unspecified",
  });

  server.registerTool(
    "project_status",
    {
      description:
        "Current state of the aeros project: recent progress from every agent, tasks in flight " +
        "and how many decisions are recorded. Call this before starting any work, then " +
        "git_workflow before touching git.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [progress, tasks, decisions] = await Promise.all([
        store.recentProgress(20),
        store.tasks(),
        store.decisions(),
      ]);
      return text({ you: identity.author, tasks_in_flight: tasks, recent_progress: progress, decisions: decisions.length });
    },
  );

  server.registerTool(
    "get_conventions",
    {
      description: "Team conventions every agent must follow: language, branches, commits, data, layout, " +
        "and the AWS Free plan limits (aws_free_plan) that bind any infrastructure change.",
      annotations: { readOnlyHint: true },
    },
    async () => text(await store.conventions()),
  );

  server.registerTool(
    "git_workflow",
    {
      description:
        "Step-by-step git workflow for this repo: claiming work, branch naming, commit format, " +
        "rebasing on develop, pull requests, local --no-ff merges and releases. Read it before " +
        "creating a branch, committing, pushing or merging.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      text(
        (await store.gitWorkflow()).map((c, i) => `${i + 1}. ${c.key}: ${c.value}`).join("\n\n"),
      ),
  );

  server.registerTool(
    "set_convention",
    {
      description: "Create or replace a team convention. Use only when the team agreed on it.",
      inputSchema: z.object({ key: z.string().min(1).max(60), value: z.string().min(1).max(2000) }),
    },
    async ({ key, value }) => {
      await store.setConvention(actor(), key, value);
      return text(`convention "${key}" saved`);
    },
  );

  server.registerTool(
    "log_progress",
    {
      description: "Record what you just did, so the other agents and people see it.",
      inputSchema: z.object({ text: z.string().min(1).max(4000), agent: agentArg }),
    },
    async ({ text: entry, agent }) => {
      await store.logProgress(actor(agent), entry);
      return text("logged");
    },
  );

  server.registerTool(
    "claim_task",
    {
      description:
        "Claim a task (e.g. a file area like web/src/map or a feature) before touching it. Fails if " +
        "someone else holds it.",
      inputSchema: z.object({
        task: z.string().min(1).max(120),
        note: z.string().max(500).optional(),
        agent: agentArg,
      }),
    },
    async ({ task, note, agent }) => {
      try {
        return text(await store.claimTask(actor(agent), task, note ?? ""));
      } catch (error) {
        if (error instanceof TaskConflictError) return failure(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "release_task",
    {
      description: "Release a task you hold once the work is merged or abandoned.",
      inputSchema: z.object({ task: z.string().min(1).max(120) }),
    },
    async ({ task }) => {
      try {
        const released = await store.releaseTask(actor(), task);
        return text(released ? `released "${task}"` : `"${task}" was not claimed`);
      } catch (error) {
        if (error instanceof TaskConflictError) return failure(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "record_decision",
    {
      description: "Record a technical or product decision with its reasoning.",
      inputSchema: z.object({ title: z.string().min(1).max(160), body: z.string().min(1).max(6000) }),
    },
    async ({ title, body }) => {
      await store.recordDecision(actor(), title, body);
      return text("decision recorded");
    },
  );

  server.registerTool(
    "list_decisions",
    { description: "Every recorded decision, oldest first.", annotations: { readOnlyHint: true } },
    async () => text(await store.decisions()),
  );

  server.registerTool(
    "model_metrics",
    {
      description:
        "Out-of-sample scores of the harmonization models (temporal and spatial hold-out), the " +
        "chosen model and its dispersion terms.",
      annotations: { readOnlyHint: true },
    },
    async () => text(await data.validation()),
  );

  server.registerTool(
    "burning_calendar",
    {
      description:
        "Harmonized monthly hotspot counts for the validation region, with 90 % interval, raw " +
        "stacked count and anomaly against the same-month median.",
      inputSchema: z.object({
        from_year: z.number().int().min(2000).max(2100).optional(),
        to_year: z.number().int().min(2000).max(2100).optional(),
        month: z.number().int().min(1).max(12).optional(),
        unusual_only: z.boolean().optional().describe("Only months at least twice their median."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from_year, to_year, month, unusual_only }) => {
      const rows = await data.calendar({ fromYear: from_year, toYear: to_year, month });
      return text(unusual_only ? unusualMonths(rows) : rows);
    },
  );

  server.registerTool(
    "morning_loss",
    {
      description:
        "Share of daytime fire cell-days seen only by Terra (the only morning overpass) and Terra's " +
        "overpass drift per year: what the record loses when Terra stops.",
      annotations: { readOnlyHint: true },
    },
    async () => text(await data.morning()),
  );

  return server;
}
