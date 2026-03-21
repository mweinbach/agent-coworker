import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { maybeLoadReactGrabDevTools } from "./lib/reactGrabDevTools";
import "./styles.css";

const shouldLoadReactGrabDevTools =
  !navigator.userAgent.includes("Electron") || !navigator.userAgent.includes("Linux");

if (shouldLoadReactGrabDevTools) {
  void maybeLoadReactGrabDevTools();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
