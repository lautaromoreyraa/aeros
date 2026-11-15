// Turns the recorded steering prompts into the study the team presents: which
// prompts redirected the product, what situation each answered and what was
// decided. Pure and deterministic, so the same log always yields the same text.

import { PROMPT_CATEGORIES, PROMPTERS, type SteeringPrompt } from "./store";

const PERSON: Record<string, string> = { lautaro: "Lautaro", david: "David" };

const day = (iso: string) => iso.slice(0, 10);
const person = (p: SteeringPrompt) => PERSON[p.prompted_by] ?? p.prompted_by;
const quote = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

function count<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function turningPoint(p: SteeringPrompt, position: number): string {
  const lines = [
    `### ${position}. ${p.title}`,
    `*${day(p.occurred_at)} · ${p.category} · ${person(p)} via ${p.agent}*`,
    "",
    quote(p.prompt),
    "",
    `- **Situation:** ${p.situation}`,
    `- **Decision:** ${p.decision}`,
  ];
  if (p.impact) lines.push(`- **Impact:** ${p.impact}`);
  if (p.refs) lines.push(`- **References:** ${p.refs}`);
  return lines.join("\n");
}

export function renderStudy(prompts: SteeringPrompt[]): string {
  if (!prompts.length) return "# How the product was steered\n\nNo steering prompts recorded yet.\n";

  const byPerson = count(prompts, (p) => person(p));
  const byAgent = count(prompts, (p) => p.agent);
  const summary = (counts: Map<string, number>) =>
    [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ");
  const first = day(prompts[0]!.occurred_at);
  const last = day(prompts[prompts.length - 1]!.occurred_at);

  const turning = prompts.filter((p) => p.importance === 3);
  const others = prompts.filter((p) => p.importance < 3);

  const out: string[] = [
    "# How the product was steered",
    "",
    `${prompts.length} steering prompts, ${first === last ? first : `${first} to ${last}`}. ` +
      `Prompted by ${summary(byPerson)}; logged by ${summary(byAgent)}.`,
  ];

  out.push("", "## Turning points", "");
  out.push(
    turning.length
      ? turning.map((p, i) => turningPoint(p, i + 1)).join("\n\n")
      : "No prompt has been marked as a turning point yet.",
  );

  if (others.length) {
    out.push("", "## Other steering prompts", "");
    out.push(
      ...others.map(
        (p) => `- ${day(p.occurred_at)} · ${p.category} · ${person(p)} via ${p.agent}: **${p.title}**. ${p.decision}`,
      ),
    );
  }

  const header = ["Category", ...PROMPTERS.map((x) => PERSON[x]!)];
  const rows = PROMPT_CATEGORIES.flatMap((category) => {
    const inCategory = prompts.filter((p) => p.category === category);
    if (!inCategory.length) return [];
    const cells = PROMPTERS.map((x) => String(inCategory.filter((p) => p.prompted_by === x).length));
    return [`| ${[category, ...cells].join(" | ")} |`];
  });
  out.push(
    "",
    "## By category",
    "",
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows,
  );

  return `${out.join("\n")}\n`;
}
