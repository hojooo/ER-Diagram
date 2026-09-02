import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { englishMessages, koreanMessages, type UiMessages } from "./messages.js";

export type UiLocale = "ko" | "en";

export const DEFAULT_UI_LOCALE: UiLocale = "ko";
export const UI_LOCALE_STORAGE_KEY = "er-diagram.ui-locale.v1";

const INTL_LOCALES = {
  ko: "ko-KR",
  en: "en-US",
} as const satisfies Record<UiLocale, string>;

const MESSAGE_CATALOGS = {
  ko: koreanMessages,
  en: englishMessages,
} satisfies Record<UiLocale, UiMessages>;

export interface UiLocaleContextValue {
  readonly locale: UiLocale;
  readonly messages: UiMessages;
  readonly setLocale: (locale: UiLocale) => void;
  readonly formatDate: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const ENGLISH_TEST_FALLBACK: UiLocaleContextValue = {
  locale: "en",
  messages: englishMessages,
  setLocale: () => undefined,
  formatDate: (value, options) =>
    new Intl.DateTimeFormat(INTL_LOCALES.en, options).format(toDate(value)),
  formatNumber: (value, options) => new Intl.NumberFormat(INTL_LOCALES.en, options).format(value),
};

const UiLocaleContext = createContext<UiLocaleContextValue>(ENGLISH_TEST_FALLBACK);

export function UiLocaleProvider({
  children,
  initialLocale,
}: {
  readonly children: ReactNode;
  readonly initialLocale?: UiLocale;
}) {
  const [locale, setLocaleState] = useState<UiLocale>(() => initialLocale ?? readStoredLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: UiLocale) => {
    setLocaleState(nextLocale);
    try {
      globalThis.localStorage?.setItem(UI_LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The current in-memory selection remains authoritative when storage is unavailable.
    }
  }, []);

  const value = useMemo<UiLocaleContextValue>(() => {
    const intlLocale = INTL_LOCALES[locale];
    return {
      locale,
      messages: MESSAGE_CATALOGS[locale],
      setLocale,
      formatDate: (dateValue, options) =>
        new Intl.DateTimeFormat(intlLocale, options).format(toDate(dateValue)),
      formatNumber: (numberValue, options) =>
        new Intl.NumberFormat(intlLocale, options).format(numberValue),
    };
  }, [locale, setLocale]);

  return <UiLocaleContext.Provider value={value}>{children}</UiLocaleContext.Provider>;
}

export function useUiLocale(): UiLocaleContextValue {
  return useContext(UiLocaleContext);
}

export function LanguageSelect({ className = "" }: { readonly className?: string }) {
  const { locale, messages, setLocale } = useUiLocale();
  return (
    <label
      className={`inline-flex items-center gap-2 text-xs font-semibold text-slate-300 ${className}`}
    >
      <span>{messages["language.label"]}</span>
      <select
        aria-label={messages["language.label"]}
        className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        value={locale}
        onChange={(event) => setLocale(event.currentTarget.value as UiLocale)}
      >
        <option value="ko">{messages["language.korean"]}</option>
        <option value="en">{messages["language.english"]}</option>
      </select>
    </label>
  );
}

function readStoredLocale(): UiLocale {
  try {
    const value = globalThis.localStorage?.getItem(UI_LOCALE_STORAGE_KEY);
    return value === "ko" || value === "en" ? value : DEFAULT_UI_LOCALE;
  } catch {
    return DEFAULT_UI_LOCALE;
  }
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}
