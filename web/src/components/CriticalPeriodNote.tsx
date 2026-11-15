import type { CriticalPeriod } from "../api/types";
import { useI18n } from "../i18n/I18nContext";
import { monthLabel } from "../util/months";

/** One line naming the fire season the calendar highlights. */
export function CriticalPeriodNote({ period }: { period: CriticalPeriod }) {
  const { lang, t } = useI18n();
  if (period.months.length === 0 || period.start_month === null || period.end_month === null) {
    return <p className="critical-note">{t.criticalPeriod.noSeason}</p>;
  }
  const name = (month: number) => monthLabel(month - 1, lang);
  const held = Math.round((period.held ?? period.share) * 100);
  const end = period.months.length > 1 ? name(period.end_month) : undefined;
  const peak = period.peak_month ? name(period.peak_month) : undefined;
  return (
    <p className="critical-note">
      <span className="critical-note__swatch" aria-hidden="true" />
      <span>
        <strong>{t.criticalPeriod.label(name(period.start_month), end)}</strong>
        {t.criticalPeriod.desc(held, peak)}
      </span>
    </p>
  );
}
