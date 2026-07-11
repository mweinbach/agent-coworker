import React, { Profiler } from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CrashReportingErrorBoundary } from "@/ui/CrashReportingErrorBoundary";
import "./quality.css";
import { installQualityGateRuntime, QualityCrashProbe, recordQualityGateRender } from "./runtime";

installQualityGateRuntime();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Profiler id="quality-gate-root" onRender={recordQualityGateRender}>
      <TooltipProvider>
        <CrashReportingErrorBoundary>
          <QualityCrashProbe />
          <App />
        </CrashReportingErrorBoundary>
      </TooltipProvider>
    </Profiler>
  </React.StrictMode>,
);
