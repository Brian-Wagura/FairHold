"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { IconCheck, IconMonitor, IconMoon, IconSun } from "./icons";
import { cx } from "./ui";

/**
 * Class-based dark mode (STYLES.md §11) without a dependency: same behaviour as next-themes
 * with attribute="class", defaultTheme="system", enableSystem and disableTransitionOnChange.
 * The inline script in app/layout.tsx applies the stored theme before first paint.
 */
export type Theme = "system" | "light" | "dark";
const KEY = "fairhold:theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.add("theme-switching");
  root.classList.toggle("dark", dark);
  // Re-enable transitions on the next frame so the switch itself doesn't animate.
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage blocked: still apply for this page */
  }
  apply(theme);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "system");
}

/** Keeps the page in sync with the OS setting while the theme is "system". */
export function useSystemThemeSync() {
  const theme = useTheme();
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
}

const OPTIONS: { value: Theme; label: string; Icon: typeof IconSun }[] = [
  { value: "light", label: "Light", Icon: IconSun },
  { value: "dark", label: "Dark", Icon: IconMoon },
  { value: "system", label: "System", Icon: IconMonitor },
];

/**
 * Theme menu (STYLES.md iconButtonClass trigger): explicit Light / Dark / System choices, so a
 * click always does what it says, whatever the OS setting is.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  useSystemThemeSync();
  const ref = useRef<HTMLDetailsElement>(null);
  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2]!;

  // Close on outside click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details ref={ref} className={cx("relative", className)}>
      <summary
        aria-label={`Theme: ${current.label}. Change theme`}
        title={`Theme: ${current.label}`}
        className="relative inline-flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white [&::-webkit-details-marker]:hidden"
      >
        <current.Icon size={18} />
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-40 rounded-xl border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-800" role="group" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={theme === o.value}
            onClick={() => {
              setTheme(o.value);
              // Close the menu and return focus to its trigger, as the Escape handler does.
              if (ref.current) {
                ref.current.open = false;
                ref.current.querySelector("summary")?.focus();
              }
            }}
            className={cx(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
              theme === o.value
                ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-700/70 dark:text-white"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700/40 dark:hover:text-white",
            )}
          >
            <o.Icon size={16} />
            <span className="flex-1 text-left">{o.label}</span>
            {theme === o.value && <IconCheck size={14} />}
          </button>
        ))}
      </div>
    </details>
  );
}
