import type { ReactNode } from "react";
import { DataCredits } from "../components/DataCredits";

export type Section = "calendar" | "terrain" | "warning" | "forecast" | "past";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "calendar", label: "Calendar" },
  { value: "terrain", label: "Terrain" },
  { value: "warning", label: "Early warning" },
  // The weekly outlook stays in the code. It is off the nav for this MVP.
  { value: "past", label: "Past fires" },
];

interface Props {
  section: Section;
  onSectionChange: (section: Section) => void;
  /** Marks the early-warning tab while an alert is active. */
  alerting: boolean;
  /** Shown above every view, under the header. */
  banner?: ReactNode;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onShowLanding: () => void;
  children: ReactNode;
}

export function AppShell({ section, onSectionChange, alerting, banner, theme, onToggleTheme, onShowLanding, children }: Props) {
  return (
    <div className="shell">
      <header className="shell__header">
        <button type="button" className="shell__back" onClick={onShowLanding} aria-label="Back to the presentation">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="shell__back-label">Back</span>
        </button>
        <a
          className="brand"
          href="./"
          aria-label="aeros, back to the presentation"
          onClick={(event) => {
            event.preventDefault();
            onShowLanding();
          }}
        >
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="currentColor" />
          </svg>
          <span>aeros</span>
        </a>
        <p className="shell__tagline">Harmonized MODIS × VIIRS fire activity</p>
        <nav className="tabs" aria-label="Views">
          {SECTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="tabs__tab"
              aria-current={section === option.value ? "page" : undefined}
              onClick={() => onSectionChange(option.value)}
            >
              {option.label}
              {option.value === "warning" && alerting && (
                <span className="tabs__dot">
                  <span className="visually-hidden"> (active alert)</span>
                </span>
              )}
            </button>
          ))}
        </nav>
        <nav className="shell__actions" aria-label="Display">
          <button
            type="button"
            className="button button--ghost"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </nav>
      </header>
      <main id="main" className="shell__main">
        {banner}
        {children}
      </main>
      <footer className="shell__footer">
        <p>
          Hotspot counts are model outputs aggregated to H3 cells; months before 2012 are translated from MODIS to
          VIIRS-equivalent values with a 90 % interval. The early warning and the forecast are statistical, not
          official fire alerts.
        </p>
        <DataCredits />
      </footer>
    </div>
  );
}
