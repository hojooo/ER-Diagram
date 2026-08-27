import { Component, type ErrorInfo, type ReactNode } from "react";

interface RootErrorBoundaryProps {
  readonly children: ReactNode;
}

interface RootErrorBoundaryState {
  readonly hasError: boolean;
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Web application render failed", {
      errorName: error.name,
      componentStack: info.componentStack,
    });
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
        <section className="max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
          <h1 className="text-2xl font-semibold text-white">Application error</h1>
          <p className="mt-3 text-slate-300">
            The application could not continue. No project source was changed by this page error.
          </p>
          <button
            className="mt-6 min-h-11 rounded-lg bg-cyan-300 px-5 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
            type="button"
            onClick={() => globalThis.location.reload()}
          >
            Reload application
          </button>
        </section>
      </main>
    );
  }
}
