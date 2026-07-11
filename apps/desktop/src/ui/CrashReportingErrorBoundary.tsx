import { AlertTriangleIcon, RotateCwIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { captureRendererError } from "../lib/crashReporting";
import { RecoveryDiagnosticsActions } from "./recovery/RecoveryDiagnosticsActions";

type CrashReportingErrorBoundaryProps = {
  children: ReactNode;
  captureError?: typeof captureRendererError;
};

type CrashReportingErrorBoundaryState = {
  hasError: boolean;
  errorDetail: string | null;
};

export class CrashReportingErrorBoundary extends Component<
  CrashReportingErrorBoundaryProps,
  CrashReportingErrorBoundaryState
> {
  state: CrashReportingErrorBoundaryState = { hasError: false, errorDetail: null };

  static getDerivedStateFromError(error: Error): CrashReportingErrorBoundaryState {
    return { hasError: true, errorDetail: error.message.trim() || null };
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
        <div className="flex w-full max-w-lg flex-col items-start gap-4 rounded-xl border border-destructive/30 bg-background p-6 shadow-sm">
          <div>
            <div className="text-xl font-semibold">Cowork hit an unexpected error</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Reload this window to recover. Your saved chats and drafts remain on this device.
            </p>
          </div>
          {this.state.errorDetail ? (
            <div
              data-selectable="text"
              className="w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground"
            >
              {this.state.errorDetail}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => window.location.reload()}>
              Reload Cowork
            </Button>
            <RecoveryDiagnosticsActions />
          </div>
        </div>
      </div>
    );
  }
}

/**
 * Default inline fallback rendered by {@link InlineErrorBoundary}. Mirrors the
 * destructive-toned tile already used in `FeedRow` (error rows) and the
 * `UnknownComponent` fallback so a localized crash reads as part of the UI
 * rather than a window-level fault.
 */
function DefaultInlineFallback({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{label}</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onRetry}
        className="h-6 gap-1 px-1.5 text-xs text-destructive hover:bg-destructive/15"
      >
        <RotateCwIcon className="size-3" aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

type InlineErrorBoundaryProps = {
  children: ReactNode;
  /**
   * Short message shown in the default fallback (e.g. "This message couldn't
   * be rendered"). Ignored when a custom `fallback` is supplied.
   */
  label?: string;
  /**
   * Optional custom fallback. Receives a `retry` callback that clears the
   * error state and re-renders children.
   */
  fallback?: (retry: () => void) => ReactNode;
  captureError?: typeof captureRendererError;
};

type InlineErrorBoundaryState = { hasError: boolean };

/**
 * A localized, non-fullscreen error boundary. Use it to wrap a single feed
 * item, surface, canvas, or settings panel so one bad subtree degrades
 * to a small inline tile instead of taking down the whole window. Errors are
 * still forwarded to `captureRendererError` for telemetry.
 *
 * The window-level {@link CrashReportingErrorBoundary} remains the backstop
 * at the app root.
 */
export class InlineErrorBoundary extends Component<
  InlineErrorBoundaryProps,
  InlineErrorBoundaryState
> {
  state: InlineErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): InlineErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const capture = this.props.captureError ?? captureRendererError;
    capture(error, {
      tags: { operation: "react_inline_error_boundary" },
      extra: { componentStack: info.componentStack ?? "" },
    });
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    if (this.props.fallback) {
      return this.props.fallback(this.handleRetry);
    }
    return (
      <DefaultInlineFallback
        label={this.props.label ?? "This couldn't be rendered."}
        onRetry={this.handleRetry}
      />
    );
  }
}
