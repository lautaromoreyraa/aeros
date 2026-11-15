import { StrictMode } from "react";
import "@fontsource-variable/archivo/standard.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n/I18nContext";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/explorer.css";
import "./styles/outlook.css";
import "./styles/landing.css";
import "./styles/terrain.css";
import "./styles/past-fires.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
