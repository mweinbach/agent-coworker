import React, { Profiler } from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { initProductAnalytics } from "./lib/analytics";
import { initRendererCrashReporting } from "./lib/crashReporting";
import { maybeLoadReactGrabDevTools } from "./lib/reactGrabDevTools";
import { installQualityGateRuntime, recordQualityGateRender } from "./quality-gates/runtime";
import "./styles.css";
import { CrashReportingErrorBoundary } from "./ui/CrashReportingErrorBoundary";

void initRendererCrashReporting();
initProductAnalytics();
void maybeLoadReactGrabDevTools();
installQualityGateRuntime();

const app = (
  <TooltipProvider>
    <CrashReportingErrorBoundary>
      <App />
    </CrashReportingErrorBoundary>
  </TooltipProvider>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {window.cowork?.qualityGateMode === true ? (
      <Profiler id="quality-gate-root" onRender={recordQualityGateRender}>
        {app}
      </Profiler>
    ) : (
      app
    )}
  </React.StrictMode>,
);
