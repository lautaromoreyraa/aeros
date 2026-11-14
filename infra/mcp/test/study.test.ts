import { describe, expect, it } from "vitest";
import { renderStudy } from "../src/study";
import type { SteeringPrompt } from "../src/store";

let nextId = 1;
function prompt(overrides: Partial<SteeringPrompt> = {}): SteeringPrompt {
  return {
    id: nextId++,
    prompted_by: "lautaro",
    author: "service:shared-token",
    agent: "claude",
    category: "scope",
    importance: 3,
    title: "Reuse David's downloader",
    prompt: "Sí, reencauzar",
    situation: "Both of us were downloading the same archive.",
    decision: "Use aeros fetch and drop the rectangular cut.",
    impact: "",
    refs: "",
    occurred_at: "2026-11-14T17:30:00Z",
    ...overrides,
  };
}

describe("renderStudy", () => {
  it("says so when nothing is recorded", () => {
    expect(renderStudy([])).toContain("No steering prompts recorded yet.");
  });

  it("opens with the span and who prompted and logged", () => {
    const text = renderStudy([
      prompt({ occurred_at: "2026-11-13T10:00:00Z" }),
      prompt({ prompted_by: "david", agent: "devin" }),
      prompt({ prompted_by: "lautaro", agent: "claude" }),
    ]);
    expect(text).toContain("3 steering prompts, 2026-11-13 to 2026-11-14.");
    expect(text).toContain("Prompted by Lautaro 2, David 1; logged by claude 2, devin 1.");
  });

  it("presents each turning point with the quote, situation and decision, in order", () => {
    const text = renderStudy([
      prompt({ title: "First", prompt: "line one\nline two", occurred_at: "2026-11-13T10:00:00Z" }),
      prompt({ title: "Second", prompted_by: "david", agent: "devin" }),
    ]);
    expect(text.indexOf("### 1. First")).toBeLessThan(text.indexOf("### 2. Second"));
    expect(text).toContain("> line one\n> line two");
    expect(text).toContain("*2026-11-14 · scope · David via devin*");
    expect(text).toContain("- **Situation:** Both of us were downloading the same archive.");
    expect(text).toContain("- **Decision:** Use aeros fetch and drop the rectangular cut.");
  });

  it("leaves out impact and references when there are none", () => {
    const bare = renderStudy([prompt()]);
    expect(bare).not.toContain("**Impact:**");
    expect(bare).not.toContain("**References:**");
    const full = renderStudy([prompt({ impact: "Two branches deleted.", refs: "PR 2" })]);
    expect(full).toContain("- **Impact:** Two branches deleted.");
    expect(full).toContain("- **References:** PR 2");
  });

  it("keeps lesser prompts compact and apart from the turning points", () => {
    const text = renderStudy([prompt({ importance: 2, title: "Cell size", category: "data" })]);
    expect(text).toContain("No prompt has been marked as a turning point yet.");
    expect(text).toContain("## Other steering prompts");
    expect(text).toContain("- 2026-11-14 · data · Lautaro via claude: **Cell size**.");
  });

  it("counts prompts per category and person, skipping empty categories", () => {
    const text = renderStudy([
      prompt({ category: "data" }),
      prompt({ category: "data", prompted_by: "david" }),
      prompt({ category: "process" }),
    ]);
    expect(text).toContain("| Category | Lautaro | David |");
    expect(text).toContain("| data | 1 | 1 |");
    expect(text).toContain("| process | 1 | 0 |");
    expect(text).not.toContain("| security |");
  });
});
