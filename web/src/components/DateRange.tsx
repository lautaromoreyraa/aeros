import { useEffect, useState } from "react";
import { clampMonth, formatMonth, parseMonth } from "../util/months";

interface Props {
  start: number;
  end: number;
  min: number;
  max: number;
  onChange: (start: number, end: number) => void;
}

const PRESETS = [
  { label: "All years", years: null },
  { label: "VIIRS era", from: "2012-01" },
  { label: "Last 5 years", years: 5 },
] as const;

/**
 * Month range. Native month inputs, so phones get their own picker; browsers
 * without one fall back to a text field that accepts YYYY-MM.
 */
export function DateRange({ start, end, min, max, onChange }: Props) {
  const [draft, setDraft] = useState({ start: formatMonth(start), end: formatMonth(end) });
  useEffect(() => setDraft({ start: formatMonth(start), end: formatMonth(end) }), [start, end]);

  const commit = (next: { start: string; end: string }) => {
    const a = parseMonth(next.start);
    const b = parseMonth(next.end);
    if (a === null || b === null) return;
    const from = clampMonth(Math.min(a, b), min, max);
    const to = clampMonth(Math.max(a, b), min, max);
    onChange(from, to);
  };

  const update = (key: "start" | "end", value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    commit(next);
  };

  return (
    <section className="panel" aria-labelledby="range-title">
      <div className="panel__head">
        <h2 id="range-title" className="panel__title">
          Dates
        </h2>
      </div>
      <div className="range">
        <label className="field">
          <span>From</span>
          <input
            type="month"
            min={formatMonth(min)}
            max={formatMonth(max)}
            value={draft.start}
            onChange={(event) => update("start", event.target.value)}
          />
        </label>
        <label className="field">
          <span>To</span>
          <input
            type="month"
            min={formatMonth(min)}
            max={formatMonth(max)}
            value={draft.end}
            onChange={(event) => update("end", event.target.value)}
          />
        </label>
      </div>
      <div className="chips">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="chip"
            onClick={() => {
              if ("from" in preset) onChange(clampMonth(parseMonth(preset.from) ?? min, min, max), max);
              else if (preset.years === null) onChange(min, max);
              else onChange(clampMonth(max - preset.years * 12 + 1, min, max), max);
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}
