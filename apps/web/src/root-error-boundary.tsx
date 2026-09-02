import { Component, type ErrorInfo, type ReactNode } from "react";
import { LanguageSelect, useUiLocale } from "./localization/ui-locale.js";

interface RootErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
}

interface RootErrorBoundaryState {
  readonly hasError: boolean;
}

class RootErrorBoundaryImpl extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
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
    return this.props.fallback;
  }
}

export function RootErrorBoundary({ children }: { readonly children: ReactNode }) {
  const { messages } = useUiLocale();
  return (
    <RootErrorBoundaryImpl
      fallback={
        <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
          <LanguageSelect className="absolute right-6 top-6" />
          <section className="max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
            <h1 className="text-2xl font-semibold text-white">{messages["rootError.title"]}</h1>
            <p className="mt-3 text-slate-300">{messages["rootError.message"]}</p>
            <button
              className="mt-6 min-h-11 rounded-lg bg-cyan-300 px-5 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
              type="button"
              onClick={() => globalThis.location.reload()}
            >
              {messages["rootError.reload"]}
            </button>
          </section>
        </main>
      }
    >
      {children}
    </RootErrorBoundaryImpl>
  );
}
