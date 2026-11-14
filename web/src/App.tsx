import { useRegion } from "./hooks/useRegion";
import { useTheme } from "./hooks/useTheme";
import { AppShell } from "./layout/AppShell";
import { ExplorerPage } from "./pages/ExplorerPage";

export default function App() {
  const { state, retry } = useRegion();
  const { resolved, toggle } = useTheme();

  return (
    <AppShell theme={resolved} onToggleTheme={toggle}>
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
  );
}
