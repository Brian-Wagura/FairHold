"use client";

import { useEffect, useSyncExternalStore } from "react";
import { IconMonitor, IconMoon, IconSun } from "./icons";
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

const ORDER: Theme[] = ["system", "light", "dark"];
const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

/** Icon button that cycles System → Light → Dark (STYLES.md iconButtonClass). */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  useSystemThemeSync();
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
  const Icon = theme === "dark" ? IconMoon : theme === "light" ? IconSun : IconMonitor;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[theme]}`}
      className={cx(
        "relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white",
        className,
      )}
    >
      <Icon size={18} />
    </button>
  );
}
