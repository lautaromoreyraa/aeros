import { useCallback, useState } from "react";
import { useRegion } from "./hooks/useRegion";
import { useTheme } from "./hooks/useTheme";
import { AppShell } from "./layout/AppShell";
import { ExplorerPage } from "./pages/ExplorerPage";
import { IntroPage } from "./pages/IntroPage";

const INTRO_KEY = "aeros-intro-seen";

function introAlreadySeen(): boolean {
  try {
    return sessionStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const { state, retry } = useRegion();
  const { resolved, toggle } = useTheme();
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
      {showIntro && <IntroPage region={state.status === "ready" ? state.data : null} onDone={finishIntro} />}
      {explorerMounted && (
        <div inert={showIntro || undefined}>
          <AppShell theme={resolved} onToggleTheme={toggle} onReplayIntro={() => setShowIntro(true)}>
            {state.status === "loading" && <p className="status">Loading the burning calendar…</p>}
            {state.status === "error" && (
              <div className="status" role="alert">
                <p>The data could not be loaded: {state.message}</p>
                <button type="button" className="button" onClick={retry}>
                  Try again
                </button>
              </div>
            )}
            {state.status === "ready" && <ExplorerPage region={state.data} theme={resolved} />}
          </AppShell>
        </div>
      )}
    </>
  );
}
