/**
 * Visible mark required by the NASA Space Apps rule on Super Intelligence
 * tools. The full statement of what those tools did, and what they did not
 * generate, is in the page footer and the document metadata.
 */
export function SiMark({ place, dark = false }: { place: "hero" | "record" | "section" | "map" | "figure"; dark?: boolean }) {
  return (
    <p className={["si-mark", `si-mark--${place}`, dark && "si-mark--dark"].filter(Boolean).join(" ")} aria-hidden="true">
      Assisted by SI tools
    </p>
  );
}
