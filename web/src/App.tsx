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
import { IntroPage } from "./pages/IntroPage";
import { TerrainPage } from "./pages/TerrainPage";
import { alertDecision } from "./util/earlyWarning";

const INTRO_KEY = "aeros-intro-seen";

function introAlreadySeen(): boolean {
  try {
    return sessionStorage.getItem(INTRO_KEY) === "1";
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
  const [showIntro, setShowIntro] = useState(() => !introAlreadySeen());
  // The explorer first mounts after the intro: starting deck.gl behind the 3D
  // scene compiles its shaders on the same thread and freezes the intro. Once
  // mounted it stays, so replaying the intro keeps the chosen area.
  const [explorerMounted, setExplorerMounted] = useState(introAlreadySeen);

  const finishIntro = useCallback(() => {
    setShowIntro(false);
    setExplorerMounted(true);
    try {
      sessionStorage.setItem(INTRO_KEY, "1");
    } catch {
      // Without storage the intro simply plays again on reload.
    }
  }, []);

  return (
    <>
      {showIntro && <IntroPage region={state.data} onDone={finishIntro} />}
      {explorerMounted && (
        <div inert={showIntro || undefined}>
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
            onReplayIntro={() => setShowIntro(true)}
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
