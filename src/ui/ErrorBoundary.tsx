import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "./components";

interface Props {
  children: ReactNode;
  /** Overridable so tests don't reload the test runner. */
  onReload?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors so a crash shows an explanation rather than a blank
 * window. This matters more in the packaged app than in the browser: there is
 * no console for the person using it, so without this a thrown error looks
 * like the app simply died.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the detail in the dev console for `npm run tauri dev`.
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const reload = this.props.onReload ?? (() => window.location.reload());
    return (
      <div className="card" style={{ margin: 32, maxWidth: 640 }}>
        <div className="card-head">
          <div className="card-title">Something went wrong</div>
        </div>
        <p className="muted">
          Ledgerly hit an error it could not recover from. Your data is safe — nothing
          is written when a screen fails to draw. Reloading usually clears it.
        </p>
        <pre className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
          {error.message}
        </pre>
        <Button onClick={reload}>Reload</Button>
      </div>
    );
  }
}
