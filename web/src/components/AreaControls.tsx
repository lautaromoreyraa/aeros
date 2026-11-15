import { useId, useState, type FormEvent } from "react";
import { parseBox, type Area, type BoundingBox, type BoxErrors } from "../util/area";

export type AreaMode = "region" | "draw" | "box";

interface Props {
  mode: AreaMode;
  onModeChange: (mode: AreaMode) => void;
  area: Area;
  draftVertices: number;
  onFinishDrawing: () => void;
  onCancelDrawing: () => void;
  onApplyBox: (box: BoundingBox) => void;
  regionBounds: BoundingBox;
  selectedCells: number;
  totalCells: number;
}

const MODES: { value: AreaMode; label: string }[] = [
  { value: "region", label: "Whole region" },
  { value: "draw", label: "Draw" },
  { value: "box", label: "Lat / lon" },
];

const round = (value: number) => String(Math.round(value * 100) / 100);

export function AreaControls(props: Props) {
  const { mode, onModeChange, draftVertices, selectedCells, totalCells } = props;
  // Several views can show these controls at once; ids and the radio group must stay apart.
  const id = useId();
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="panel__head">
        <h2 id={`${id}-title`} className="panel__title">
          Area
        </h2>
        <span className="panel__meta" aria-live="polite">
          {selectedCells} of {totalCells} cells
        </span>
      </div>
      <fieldset className="segmented" aria-label="How to choose the area">
        {MODES.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={`${id}-mode`}
              value={option.value}
              checked={mode === option.value}
              onChange={() => onModeChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      {mode === "draw" && (
        <div className="draw-help">
          <p>
            {draftVertices === 0
              ? props.area.kind === "polygon"
                ? "Area set. Click or tap the map again to start a new one."
                : "Click or tap the map to place the corners of your area."
              : `${draftVertices} corner${draftVertices === 1 ? "" : "s"} placed. Add at least three, then finish.`}
          </p>
          <div className="draw-help__actions">
            <button type="button" className="button button--primary" disabled={draftVertices < 3} onClick={props.onFinishDrawing}>
              Finish area
            </button>
            <button type="button" className="button button--ghost" disabled={draftVertices === 0} onClick={props.onCancelDrawing}>
              Clear
            </button>
          </div>
        </div>
      )}
      {mode === "box" && <BoxForm initial={props.area.kind === "box" ? props.area.box : props.regionBounds} onApply={props.onApplyBox} />}
    </section>
  );
}

function BoxForm({ initial, onApply }: { initial: BoundingBox; onApply: (box: BoundingBox) => void }) {
  const [fields, setFields] = useState({
    north: round(initial.north),
    south: round(initial.south),
    west: round(initial.west),
    east: round(initial.east),
  });
  const [errors, setErrors] = useState<BoxErrors>({});
  const id = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = parseBox(fields);
    if ("errors" in result) setErrors(result.errors);
    else {
      setErrors({});
      onApply(result.box);
    }
  };

  const input = (key: keyof BoundingBox, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={fields[key]}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `${id}-${key}-error` : undefined}
        onChange={(event) => setFields((previous) => ({ ...previous, [key]: event.target.value }))}
      />
      {errors[key] && (
        <span id={`${id}-${key}-error`} className="field-error">
          {errors[key]}
        </span>
      )}
    </label>
  );

  return (
    <form className="box-form" onSubmit={submit} noValidate>
      <div className="box-form__grid">
        {input("north", "North lat")}
        {input("south", "South lat")}
        {input("west", "West lon")}
        {input("east", "East lon")}
      </div>
      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
      <button type="submit" className="button button--primary">
        Apply box
      </button>
    </form>
  );
}
