import type { ReactNode } from "react";
import { DataCredits } from "../components/DataCredits";
import { useI18n } from "../i18n/I18nContext";

export type Section = "calendar" | "terrain" | "warning" | "forecast" | "past";

interface Props {
  section: Section;
  onSectionChange: (section: Section) => void;
  /** Marks the early-warning tab while an alert is active. */
  alerting: boolean;
  /** Shown above every view, under the header. */
  banner?: ReactNode;
  onShowLanding: () => void;
  children: ReactNode;
}

export function AppShell({ section, onSectionChange, alerting, banner, onShowLanding, children }: Props) {
  const { lang, toggleLang, t } = useI18n();

  const sections: { value: Section; label: string }[] = [
    { value: "calendar", label: t.shell.calendar },
    { value: "terrain", label: t.shell.terrain },
    { value: "warning", label: t.shell.warning },
    { value: "forecast", label: t.shell.forecast },
    { value: "past", label: t.shell.past },
  ];

  return (
    <div className="shell">
      <header className="shell__header">
        <button type="button" className="shell__back" onClick={onShowLanding} aria-label={t.shell.backAria}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="shell__back-label">{t.shell.back}</span>
        </button>
        <a
          className="brand"
          href="./"
          aria-label={t.shell.brandAria}
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
        <p className="shell__tagline">{t.shell.tagline}</p>
        <nav className="tabs" aria-label={t.shell.views}>
          {sections.map((option) => (
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
                  <span className="visually-hidden">{t.shell.activeAlert}</span>
                </span>
              )}
            </button>
          ))}
        </nav>
        <nav className="shell__actions" aria-label="Language">
          <button
            type="button"
            className="button button--ghost shell__lang-switch"
            onClick={toggleLang}
            aria-label={t.shell.switchLang}
          >
            <span className={lang === "es" ? "lang-badge is-active" : "lang-badge"}>ES</span>
            <span className="lang-divider">/</span>
            <span className={lang === "en" ? "lang-badge is-active" : "lang-badge"}>EN</span>
          </button>
        </nav>
      </header>
      <main id="main" className="shell__main">
        {banner}
        {children}
      </main>
      <footer className="shell__footer">
        <p>{t.shell.footer}</p>
        <DataCredits />
      </footer>
    </div>
  );
}
