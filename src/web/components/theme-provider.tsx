import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BASE16_THEMES, DEFAULT_THEME_ID, getThemeById, getThemeCssVariables, type Base16Theme } from "../lib/themes";

const THEME_STORAGE_KEY = "worktreemanager.theme";

interface ThemeContextValue {
  theme: Base16Theme;
  themes: Base16Theme[];
  setThemeId: (themeId: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveInitialTheme(): Base16Theme {
  if (typeof window === "undefined") {
    return getThemeById(DEFAULT_THEME_ID) ?? BASE16_THEMES[0];
  }

  const storedTheme = getThemeById(window.localStorage.getItem(THEME_STORAGE_KEY));
  return storedTheme ?? getThemeById(DEFAULT_THEME_ID) ?? BASE16_THEMES[0];
}

function applyTheme(theme: Base16Theme) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  const variables = getThemeCssVariables(theme);
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.id;
  root.dataset.themeVariant = theme.variant;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState(resolveInitialTheme().id);

  const theme = useMemo(
    () => getThemeById(themeId) ?? getThemeById(DEFAULT_THEME_ID) ?? BASE16_THEMES[0],
    [themeId],
  );

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme.id);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    themes: BASE16_THEMES,
    setThemeId: (nextThemeId: string) => {
      if (!getThemeById(nextThemeId)) {
        return;
      }
      setThemeIdState(nextThemeId);
    },
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }

  return context;
}
