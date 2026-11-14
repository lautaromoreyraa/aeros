import { StrictMode } from "react";
import "@fontsource-variable/archivo/standard.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/explorer.css";
import "./styles/outlook.css";
import "./styles/landing.css";
import "./styles/terrain.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
