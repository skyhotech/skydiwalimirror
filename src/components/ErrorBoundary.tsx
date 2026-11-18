import { Component, type ReactNode } from "react";

/** Keep saved drafts intact when a renderer or lazy chunk fails. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    // Avoid logging customer photos, phone numbers or component state.
    console.error("Studio rendering failed", { type: error.name });
  }
  render() {
    if (this.state.failed)
      return (
        <main className="loading" role="alert">
          <div>
            <p>
              The studio could not display this screen. Your saved photos are
              kept on this device.
            </p>
            <button
              className="text-button"
              onClick={() => this.setState({ failed: false })}
            >
              Try opening the studio again
            </button>
          </div>
        </main>
      );
    return this.props.children;
  }
}
