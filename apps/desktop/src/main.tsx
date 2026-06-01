import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { initRendererCrashReporting } from "./lib/crashReporting";
import { maybeLoadReactGrabDevTools } from "./lib/reactGrabDevTools";
import "./styles.css";
import { CrashReportingErrorBoundary } from "./ui/CrashReportingErrorBoundary";

void initRendererCrashReporting();
void maybeLoadReactGrabDevTools();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <CrashReportingErrorBoundary>
        <App />
      </CrashReportingErrorBoundary>
    </TooltipProvider>
  </React.StrictMode>,
);
