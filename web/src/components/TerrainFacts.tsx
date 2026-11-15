import type { TerrainBrief } from "../util/terrainBrief";

interface Props {
  brief: TerrainBrief;
}

/** The three facts of the open place: alert, this week, decision. */
export function TerrainFacts({ brief }: Props) {
  return (
    <ol className={`terrain__facts terrain__facts--${brief.tone}`} aria-label="Alert and decision">
      {brief.facts.map((fact) => (
        <li
          key={fact.label}
          className={`terrain__fact terrain__fact--${fact.label === "Decision" ? "decision" : fact.label === "Alert" ? "alert" : "scale"}`}
        >
          <span className="terrain__fact-label">{fact.label}</span>
          <strong className="terrain__fact-value">{fact.value}</strong>
          <span className="terrain__fact-detail">{fact.detail}</span>
        </li>
      ))}
    </ol>
  );
}
