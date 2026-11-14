import type { CalendarRecord } from "../api/types";
import { formatCount, formatRatio } from "../util/format";
import { verdictOf, type Verdict } from "../util/sectorKpis";

export interface SectorRow {
  id: string;
  name: string;
  place: string;
  /** The sector's record for the month on the timeline, when it has one. */
  record: CalendarRecord | undefined;
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  above: "Above normal",
  normal: "Within normal range",
  below: "Below normal",
  no_baseline: "No baseline yet",
  no_data: "No data yet",
};

interface Props {
  rows: SectorRow[];
  selectedId: string;
  onSelect: (id: string) => void;
}

/** The sectors with the chosen month's value and how it compares with the usual one. */
export function SectorList({ rows, selectedId, onSelect }: Props) {
  return (
    <ul className="sector-list" aria-label="Sectors">
      {rows.map((row) => {
        const verdict = verdictOf(row.record);
        return (
          <li key={row.id}>
            <button
              type="button"
              className="sector-list__item"
              aria-pressed={selectedId === row.id}
              onClick={() => onSelect(row.id)}
            >
              <span className="sector-list__name">
                {row.name}
                <small>{row.place}</small>
              </span>
              <span className="sector-list__value">{formatCount(row.record?.harmonized ?? null)}</span>
              <span className={`chip chip--${verdict}`} title={VERDICT_LABELS[verdict]}>
                {formatRatio(row.record?.anomaly_ratio ?? null)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
