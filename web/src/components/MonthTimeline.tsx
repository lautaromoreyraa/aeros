import { formatMonth } from "../util/months";

interface Props {
  first: number;
  last: number;
  value: number;
  onChange: (month: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
}

/** Scrubs through the months of the record; every figure on the screen follows it. */
export function MonthTimeline({ first, last, value, onChange, playing, onTogglePlay }: Props) {
  return (
    <div className="timeline">
      <button type="button" className="button" aria-pressed={playing} onClick={onTogglePlay}>
        {playing ? "Pause" : "Play"}
      </button>
      <input
        type="range"
        min={first}
        max={last}
        value={value}
        aria-label="Month"
        aria-valuetext={formatMonth(value)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output className="timeline__month">{formatMonth(value)}</output>
    </div>
  );
}
