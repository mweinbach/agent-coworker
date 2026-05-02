import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { maybeLoadReactGrabDevTools } from "./lib/reactGrabDevTools";
import "./styles.css";

void maybeLoadReactGrabDevTools();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
