import { useMemo, useState } from "react";
import type { EarlyWarning } from "../api/types";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import { usePlaces } from "../hooks/usePlaces";
import { useRememberedChoice } from "../hooks/useRememberedChoice";
import { useI18n } from "../i18n/I18nContext";
import { type AlertDecision, formatDay, windowCoverage } from "../util/earlyWarning";
import { formatRatio } from "../util/format";
import { decidePlaceBanner } from "../util/placeBanner";
import { COUNTRY_NAMES, type Place } from "../util/places";

interface Props {
  report: EarlyWarning;
  decision: AlertDecision;
  /** Absent on the early-warning view itself, where the banner is the heading. */
  onOpen?: () => void;
  /** Action when clicking "See it on the map" or a ticker place chip. */
  onSeeOnMap?: (cell?: string) => void;
  resolution?: number;
}

function readStoredPlace(): Place | null {
  try {
    const raw = localStorage.getItem("aeros-place");
    return raw ? (JSON.parse(raw) as Place) : null;
  } catch {
    return null;
  }
}

/**
 * Dashboard alert banner that speaks to the reader's town: warns if a possible
 * fire is within their town or ring, otherwise runs a quiet pausable ticker of
 * fire detected elsewhere.
 */
export function AlertBanner({ report, decision, onOpen, onSeeOnMap, resolution = 4 }: Props) {
  const { lang, t } = useI18n();
  const [userPlace, setUserPlace] = useState<Place | null>(readStoredPlace);
  const reducedMotion = usePrefersReducedMotion();
  const [tickerPlaying, setTickerPlaying] = useRememberedChoice("aeros-ticker", !reducedMotion);
  const placesIndex = usePlaces(resolution);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const outcome = useMemo(
    () => decidePlaceBanner({ decision, userPlace, placesIndex, resolution, locale: lang }),
    [decision, userPlace, placesIndex, resolution, lang],
  );

  const searchResults = useMemo(() => {
    if (!placesIndex || searchQuery.trim().length < 2) return [];
    const q = searchQuery.toLowerCase().trim();
    return placesIndex.places.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6);
  }, [placesIndex, searchQuery]);

  const savePlace = (p: Place) => {
    try {
      localStorage.setItem("aeros-place", JSON.stringify(p));
    } catch {}
    setUserPlace(p);
    setShowSearch(false);
    setSearchQuery("");
  };

  const clearPlace = () => {
    try {
      localStorage.removeItem("aeros-place");
    } catch {}
    setUserPlace(null);
    setShowSearch(false);
    setSearchQuery("");
  };

  const searchPopover = (
    <div className="alert-banner__search-popover" role="dialog" aria-label={t.banner.searchTown}>
      <div className="alert-banner__search-bar">
        <input
          type="search"
          className="input alert-banner__search-input"
          placeholder={t.banner.searchTown}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setShowSearch(false);
            setSearchQuery("");
          }}
        >
          ✕
        </button>
      </div>
      {searchQuery.trim().length >= 2 && searchResults.length > 0 && (
        <ul className="alert-banner__search-results">
          {searchResults.map((p) => (
            <li key={`${p.name}-${p.region}-${p.country}`}>
              <button type="button" className="alert-banner__search-option" onClick={() => savePlace(p)}>
                <strong>{p.name}</strong>, {p.region} ({COUNTRY_NAMES[p.country] ?? p.country})
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchQuery.trim().length >= 2 && searchResults.length === 0 && (
        <p className="alert-banner__search-empty">{t.banner.noTowns}</p>
      )}
      {userPlace && (
        <button type="button" className="alert-banner__clear-town" onClick={clearPlace}>
          {t.banner.clearTown(userPlace.name)}
        </button>
      )}
    </div>
  );

  // 1. Near: possible fire near reader's town
  if (outcome.kind === "near") {
    return (
      <div className="alert-banner alert-banner--near" role="status">
        <svg className="alert-banner__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 3 2 21h20L12 3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 10v5M12 17.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="alert-banner__text">
          {outcome.text}
        </p>
        <div className="alert-banner__actions">
          {(onSeeOnMap || onOpen) && (
            <button
              type="button"
              className="button alert-banner__action"
              onClick={() => (onSeeOnMap ? onSeeOnMap(outcome.cell) : onOpen?.())}
            >
              {outcome.action}
            </button>
          )}
          <button
            type="button"
            className="button button--ghost alert-banner__town-btn"
            onClick={() => setShowSearch((v) => !v)}
            title={t.banner.changeTown}
          >
            {outcome.place.name}
          </button>
        </div>
        {showSearch && searchPopover}
      </div>
    );
  }

  // 2. Elsewhere: quiet ticker of flagged places
  if (outcome.kind === "elsewhere") {
    return (
      <div className="alert-banner alert-banner--ticker" role="status">
        <div className="alert-banner__ticker-header">
          {userPlace ? (
            <span className="alert-banner__calm-note">{t.banner.calmNear(userPlace.name)}</span>
          ) : (
            <span className="alert-banner__calm-note">{t.banner.detectedElsewhere}</span>
          )}
        </div>

        <div className="alert-banner__ticker-viewport" tabIndex={0} aria-label={t.banner.detectedElsewhere}>
          <div className={`alert-banner__ticker-track ${!tickerPlaying ? "is-paused" : ""}`}>
            {outcome.places.map((item, idx) => (
              <button
                key={`${item.cell}-${idx}`}
                type="button"
                className="alert-banner__ticker-chip"
                onClick={() => (onSeeOnMap ? onSeeOnMap(item.cell) : onOpen?.())}
              >
                <span className="alert-banner__ticker-chip-name">{item.label}</span>
                <span className="alert-banner__ticker-chip-ratio">{t.banner.aboutTheUsual(item.multiplier)}</span>
              </button>
            ))}
            {outcome.places.length > 1 &&
              outcome.places.map((item, idx) => (
                <button
                  key={`dup-${item.cell}-${idx}`}
                  type="button"
                  className="alert-banner__ticker-chip"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => (onSeeOnMap ? onSeeOnMap(item.cell) : onOpen?.())}
                >
                  <span className="alert-banner__ticker-chip-name">{item.label}</span>
                  <span className="alert-banner__ticker-chip-ratio">{t.banner.aboutTheUsual(item.multiplier)}</span>
                </button>
              ))}
          </div>
        </div>

        <div className="alert-banner__ticker-controls">
          <button
            type="button"
            className="button button--ghost alert-banner__ticker-pause"
            onClick={() => setTickerPlaying(!tickerPlaying)}
            aria-label={tickerPlaying ? t.banner.pauseTicker : t.banner.playTicker}
            title={tickerPlaying ? t.banner.pauseTicker : t.banner.playTicker}
          >
            {tickerPlaying ? (lang === "es" ? "Pausar" : "Pause") : (lang === "es" ? "Reproducir" : "Play")}
          </button>

          <button
            type="button"
            className="button button--ghost alert-banner__town-btn"
            onClick={() => setShowSearch((v) => !v)}
          >
            {userPlace ? userPlace.name : t.banner.chooseTown}
          </button>
        </div>

        {showSearch && searchPopover}
      </div>
    );
  }

  // 3. None: region alert fallback if present, else nothing
  if (decision.region && report.region) {
    const coverage = windowCoverage(report);
    return (
      <div className="alert-banner" role="status">
        <svg className="alert-banner__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 3 2 21h20L12 3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 10v5M12 17.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="alert-banner__text">
          <strong>{lang === "es" ? "Alerta temprana:" : "Early warning:"}</strong>{" "}
          {lang === "es" ? "actividad regional a" : "region-wide activity at"} {formatRatio(report.region.ratio)}{" "}
          {lang === "es" ? "lo habitual," : "the usual,"} {formatDay(report.window[0])} – {formatDay(report.window[1])}.{" "}
          <span className="alert-banner__coverage">
            {lang === "es"
              ? `Basado en ${coverage.dataDays} de ${coverage.windowDays} días con datos satelitales.`
              : `Based on ${coverage.dataDays} of ${coverage.windowDays} days with satellite data.`}
          </span>
        </p>
        {onOpen && (
          <button type="button" className="button alert-banner__action" onClick={onOpen}>
            {lang === "es" ? "Ver dónde" : "See where"}
          </button>
        )}
      </div>
    );
  }

  return null;
}
