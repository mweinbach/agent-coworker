import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { captureRendererError } from "../lib/crashReporting";

type CrashReportingErrorBoundaryProps = {
  children: ReactNode;
  captureError?: typeof captureRendererError;
};

type CrashReportingErrorBoundaryState = {
  hasError: boolean;
};

export class CrashReportingErrorBoundary extends Component<
  CrashReportingErrorBoundaryProps,
  CrashReportingErrorBoundaryState
> {
  state: CrashReportingErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CrashReportingErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const capture = this.props.captureError ?? captureRendererError;
    capture(error, {
      tags: { operation: "react_error_boundary" },
      extra: { componentStack: info.componentStack ?? "" },
    });
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="flex max-w-sm flex-col items-start gap-3">
          <div className="text-base font-semibold">Something went wrong.</div>
          <p className="text-sm text-muted-foreground">Restart Cowork to recover this window.</p>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
