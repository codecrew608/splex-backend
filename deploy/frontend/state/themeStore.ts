import { create } from "zustand";

export type ThemePreference = "light" | "dark";

const STORAGE_KEY = "splex-theme";

function applyTheme(theme: ThemePreference) {
  document.documentElement.setAttribute("data-theme", theme);
  window.localStorage.setItem(STORAGE_KEY, theme);
}

// The beforeInteractive script in layout.tsx already set data-theme on
// <html> before this module ever runs client-side, so reading it back here
// is flash-free — no separate "resolve system preference" step needed.
function getInitialTheme(): ThemePreference {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

interface ThemeState {
  theme: ThemePreference;
  toggleTheme: () => void;
  setTheme: (theme: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: getInitialTheme(),
  toggleTheme: () => {
    const next: ThemePreference = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
