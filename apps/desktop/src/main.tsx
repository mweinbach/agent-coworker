import { MotionConfig } from "framer-motion";
import React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { initProductAnalytics } from "./lib/analytics";
import { initRendererCrashReporting } from "./lib/crashReporting";
import { maybeLoadReactGrabDevTools } from "./lib/reactGrabDevTools";
import { renderRendererRoot } from "./lib/rendererRoot";
import "./styles.css";
import { CrashReportingErrorBoundary } from "./ui/CrashReportingErrorBoundary";

void initRendererCrashReporting();
initProductAnalytics();
void maybeLoadReactGrabDevTools();

renderRendererRoot(
  document.getElementById("root"),
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <CrashReportingErrorBoundary>
          <App />
        </CrashReportingErrorBoundary>
      </TooltipProvider>
    </MotionConfig>
  </React.StrictMode>,
  import.meta.hot,
);
