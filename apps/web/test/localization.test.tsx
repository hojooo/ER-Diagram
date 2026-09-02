// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { DEFAULT_RUNTIME_CONFIG_RESPONSE } from "@er-diagram/contracts";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_UI_LOCALE,
  LanguageSelect,
  UI_LOCALE_STORAGE_KEY,
  UiLocaleProvider,
  useUiLocale,
} from "../src/localization/ui-locale.js";
import { englishMessages, koreanMessages } from "../src/localization/messages.js";
import { App, createAppRoutes } from "../src/App.js";
import { createHttpProjectApi } from "../src/projects/project-api.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.lang = "";
  document.title = "";
  vi.restoreAllMocks();
});

describe("Korean-first Web localization", () => {
  it("uses Korean when no valid preference exists", () => {
    expect(DEFAULT_UI_LOCALE).toBe("ko");
    renderLocaleProbe();

    expect(screen.getByRole("status")).toHaveTextContent("한국어");
    expect(screen.getByRole("combobox", { name: "언어" })).toHaveValue("ko");
    expect(document.documentElement).toHaveAttribute("lang", "ko");
  });

  it("uses the Korean catalog in the actual App when no browser preference exists", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/runtime-config")) return jsonResponse(DEFAULT_RUNTIME_CONFIG_RESPONSE);
      if (url.endsWith("/projects")) return jsonResponse({ projects: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const api = createHttpProjectApi({ fetch: fetcher });
    const router = createMemoryRouter(createAppRoutes(), { initialEntries: ["/"] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(<App api={api} queryClient={queryClient} router={router} />);

    expect(await screen.findByRole("heading", { level: 1, name: "프로젝트" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "언어" })).toHaveValue("ko");
    expect(document.documentElement).toHaveAttribute("lang", "ko");
    expect(document.title).toBe("프로젝트 · DBML·SQL ERD Studio");
  });

  it("ignores malformed persisted values and storage read failures", () => {
    window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, "fr");
    const first = renderLocaleProbe();
    expect(screen.getByRole("status")).toHaveTextContent("한국어");
    first.unmount();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    renderLocaleProbe();
    expect(screen.getByRole("status")).toHaveTextContent("한국어");
  });

  it("persists English and restores it after remount", () => {
    const first = renderLocaleProbe();
    fireEvent.change(screen.getByRole("combobox", { name: "언어" }), {
      target: { value: "en" },
    });

    expect(screen.getByRole("status")).toHaveTextContent("English");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(window.localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("en");
    first.unmount();

    renderLocaleProbe();
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(screen.getByRole("status")).toHaveTextContent("English");
  });

  it("keeps the in-memory selection when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota");
    });
    renderLocaleProbe();

    fireEvent.change(screen.getByRole("combobox", { name: "언어" }), {
      target: { value: "en" },
    });

    expect(screen.getByRole("status")).toHaveTextContent("English");
    expect(document.documentElement).toHaveAttribute("lang", "en");
  });

  it("does not remount descendant state when the locale changes", () => {
    let mounts = 0;
    const loadProject = vi.fn();
    function StatefulProbe() {
      const [source, setSource] = useState("Table public.사용자 {\n  id bigint\n}");
      const [formDraft, setFormDraft] = useState("사용자 메모");
      useState(() => {
        mounts += 1;
        loadProject();
        return null;
      });
      const { messages } = useUiLocale();
      return (
        <div>
          <output>{messages["language.current"]}</output>
          <div data-testid="diagram">Persistent diagram</div>
          <textarea
            aria-label="DBML source"
            value={source}
            onChange={(event) => setSource(event.currentTarget.value)}
          />
          <input
            aria-label="Visual form draft"
            value={formDraft}
            onChange={(event) => setFormDraft(event.currentTarget.value)}
          />
        </div>
      );
    }

    render(
      <UiLocaleProvider>
        <LanguageSelect />
        <StatefulProbe />
      </UiLocaleProvider>,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "언어" }), {
      target: { value: "en" },
    });

    expect(mounts).toBe(1);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("DBML source")).toHaveValue(
      "Table public.사용자 {\n  id bigint\n}",
    );
    expect(screen.getByLabelText("Visual form draft")).toHaveValue("사용자 메모");
    expect(screen.getByRole("status")).toHaveTextContent("English");
  });

  it("keeps catalog keys aligned and formats interpolation, dates, and numbers by locale", () => {
    expect(Object.keys(koreanMessages).sort()).toEqual(Object.keys(englishMessages).sort());
    expect(koreanMessages["diagram.canvas"]).toBe("ER 다이어그램 캔버스");
    expect(koreanMessages["source.editorAria"]).toBe("DBML 소스 편집기");
    expect(englishMessages["diagram.canvas"]).toBe("ER diagram canvas");
    expect(englishMessages["source.editorAria"]).toBe("DBML source editor");

    const korean = render(
      <UiLocaleProvider initialLocale="ko">
        <FormattingProbe />
      </UiLocaleProvider>,
    );
    expect(screen.getByTestId("interpolation")).toHaveTextContent("오류 2개 · 경고 1개 · 정보 3개");
    expect(screen.getByTestId("date")).toHaveTextContent(
      new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date("2026-09-02T00:00:00.000Z"),
      ),
    );
    expect(screen.getByTestId("number")).toHaveTextContent(
      new Intl.NumberFormat("ko-KR").format(1234567),
    );

    korean.unmount();
    render(
      <UiLocaleProvider initialLocale="en">
        <FormattingProbe />
      </UiLocaleProvider>,
    );
    expect(screen.getByTestId("interpolation")).toHaveTextContent("2 errors · 1 warning · 3 info");
  });

  it("updates the localized title while preserving raw project, source, and diagnostic data", () => {
    const rawProject = "고객 <script>alert(1)</script>";
    const rawSource = "Table \"주문 📦\" { note varchar [note: '원문'] }";
    const rawDiagnostic = "Unexpected token at 주석 🚫";
    render(
      <UiLocaleProvider>
        <LanguageSelect />
        <RawDataProbe project={rawProject} source={rawSource} diagnostic={rawDiagnostic} />
      </UiLocaleProvider>,
    );

    expect(document.title).toBe("프로젝트 · DBML·SQL ERD Studio");
    fireEvent.change(screen.getByRole("combobox", { name: "언어" }), {
      target: { value: "en" },
    });

    expect(document.title).toBe("Projects · DBML·SQL ERD Studio");
    expect(screen.getByTestId("raw-project")).toHaveTextContent(rawProject);
    expect(screen.getByTestId("raw-source")).toHaveTextContent(rawSource);
    expect(screen.getByTestId("raw-diagnostic")).toHaveTextContent(rawDiagnostic);
  });
});

function renderLocaleProbe() {
  return render(
    <UiLocaleProvider>
      <LanguageSelect />
      <LocaleProbe />
    </UiLocaleProvider>,
  );
}

function LocaleProbe() {
  const { locale, messages } = useUiLocale();
  return (
    <div role="status">
      {messages["language.current"]}:{locale}
    </div>
  );
}

function FormattingProbe() {
  const { messages, formatDate, formatNumber } = useUiLocale();
  return (
    <>
      <output data-testid="interpolation">{messages["projects.diagnosticSummary"](2, 1, 3)}</output>
      <output data-testid="date">
        {formatDate("2026-09-02T00:00:00.000Z", { dateStyle: "medium", timeZone: "UTC" })}
      </output>
      <output data-testid="number">{formatNumber(1234567)}</output>
    </>
  );
}

function RawDataProbe({
  project,
  source,
  diagnostic,
}: {
  readonly project: string;
  readonly source: string;
  readonly diagnostic: string;
}) {
  const { messages } = useUiLocale();
  useEffect(() => {
    document.title = messages["app.documentTitle"](messages["projects.title"]);
  }, [messages]);
  return (
    <>
      <p data-testid="raw-project">{project}</p>
      <pre data-testid="raw-source">{source}</pre>
      <p data-testid="raw-diagnostic">{diagnostic}</p>
    </>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
