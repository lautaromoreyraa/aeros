import { useCallback, useMemo, useState } from "react";
import type { Unit } from "./api/types";
import { AlertBanner } from "./components/AlertBanner";
import { useAreaSelection } from "./hooks/useAreaSelection";
import { useEarlyWarning, useForecast } from "./hooks/useOutlook";
import { useRegion } from "./hooks/useRegion";
import { useTheme } from "./hooks/useTheme";
import { AppShell, type Section } from "./layout/AppShell";
import { EarlyWarningPage } from "./pages/EarlyWarningPage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { ForecastPage } from "./pages/ForecastPage";
import { LandingPage } from "./pages/LandingPage";
import { TerrainPage } from "./pages/TerrainPage";
import { alertDecision } from "./util/earlyWarning";

const ENTERED_KEY = "aeros-dashboard-entered";

function enteredBefore(): boolean {
  try {
    return sessionStorage.getItem(ENTERED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const [unit, setUnit] = useState<Unit>("hotspots");
  const { state, retry } = useRegion(unit);
  const { resolved, toggle } = useTheme();
  const [section, setSection] = useState<Section>("calendar");
  const selection = useAreaSelection();
  const warning = useEarlyWarning();
  const forecast = useForecast();
  const report = warning.state.status === "ready" ? warning.state.data : null;
  const decision = useMemo(() => alertDecision(report), [report]);
  const [onLanding, setOnLanding] = useState(() => !enteredBefore());
  // The dashboard first mounts when the visitor leaves the landing: its
  // deck.gl maps would compile their shaders on the same thread as the globe.
  // Once mounted it stays, so a visit to the landing keeps the chosen area.
  const [dashboardMounted, setDashboardMounted] = useState(enteredBefore);

  const enterDashboard = useCallback(() => {
    setOnLanding(false);
    setDashboardMounted(true);
    window.scrollTo(0, 0);
    try {
      sessionStorage.setItem(ENTERED_KEY, "1");
    } catch {
      // Without storage the landing simply shows again on reload.
    }
  }, []);

  const showLanding = useCallback(() => {
    setOnLanding(true);
    window.scrollTo(0, 0);
  }, []);

  return (
    <>
      {onLanding && <LandingPage region={state.data} warning={warning.state} onEnter={enterDashboard} />}
      {dashboardMounted && (
        <div hidden={onLanding} inert={onLanding || undefined}>
          <AppShell
            section={section}
            onSectionChange={setSection}
            alerting={decision.active}
            banner={
              report && decision.active && section !== "warning" ? (
                <AlertBanner report={report} decision={decision} onOpen={() => setSection("warning")} />
              ) : null
            }
            theme={resolved}
            onToggleTheme={toggle}
            onShowLanding={showLanding}
          >
            {!state.data && state.status === "loading" && <p className="status">Loading the burning calendar…</p>}
            {state.status === "error" && (
              <div className="status" role="alert">
                <p>The data could not be loaded: {state.message}</p>
                <button type="button" className="button" onClick={retry}>
                  Try again
                </button>
              </div>
            )}
            {/* The calendar stays mounted while another view is open, so its
                date range and picked month survive a visit to the forecast. */}
            {state.data && (
              <div hidden={section !== "calendar"}>
                <ExplorerPage
                  region={state.data}
                  theme={resolved}
                  unit={unit}
                  onUnitChange={setUnit}
                  selection={selection}
                />
              </div>
            )}
            {state.data && section === "terrain" && (
              <TerrainPage region={state.data} unit={unit} onUnitChange={setUnit} />
            )}
            {state.data && section === "warning" && (
              <EarlyWarningPage state={warning.state} onRetry={warning.retry} region={state.data} theme={resolved} />
            )}
            {state.data && section === "forecast" && (
              <ForecastPage
                state={forecast.state}
                onRetry={forecast.retry}
                region={state.data}
                theme={resolved}
                selection={selection}
              />
            )}
          </AppShell>
        </div>
      )}
    </>
  );
}
