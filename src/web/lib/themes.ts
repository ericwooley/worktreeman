import yaml from "js-yaml";

export interface Base16Palette {
  base00: string;
  base01: string;
  base02: string;
  base03: string;
  base04: string;
  base05: string;
  base06: string;
  base07: string;
  base08: string;
  base09: string;
  base0A: string;
  base0B: string;
  base0C: string;
  base0D: string;
  base0E: string;
  base0F: string;
}

export interface Base16Theme {
  id: string;
  fileName: string;
  name: string;
  author: string;
  variant: "light" | "dark";
  palette: Base16Palette;
  raw: string;
}

type Base16Key = keyof Base16Palette;

type RawThemeDocument = {
  name?: unknown;
  author?: unknown;
  variant?: unknown;
  palette?: Record<string, unknown>;
};

const REQUIRED_BASE_KEYS: Base16Key[] = [
  "base00",
  "base01",
  "base02",
  "base03",
  "base04",
  "base05",
  "base06",
  "base07",
  "base08",
  "base09",
  "base0A",
  "base0B",
  "base0C",
  "base0D",
  "base0E",
  "base0F",
];

const rawThemeModules = import.meta.glob("../themes/base16/*.{yaml,yml}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function normalizeHex(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("#") ? normalized : `#${normalized}`;
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

function parsePalette(rawPalette: RawThemeDocument["palette"], fileName: string): Base16Palette {
  if (!rawPalette) {
    throw new Error(`Theme ${fileName} is missing a palette.`);
  }

  return {
    base00: normalizePaletteValue(rawPalette.base00, fileName, "base00"),
    base01: normalizePaletteValue(rawPalette.base01, fileName, "base01"),
    base02: normalizePaletteValue(rawPalette.base02, fileName, "base02"),
    base03: normalizePaletteValue(rawPalette.base03, fileName, "base03"),
    base04: normalizePaletteValue(rawPalette.base04, fileName, "base04"),
    base05: normalizePaletteValue(rawPalette.base05, fileName, "base05"),
    base06: normalizePaletteValue(rawPalette.base06, fileName, "base06"),
    base07: normalizePaletteValue(rawPalette.base07, fileName, "base07"),
    base08: normalizePaletteValue(rawPalette.base08, fileName, "base08"),
    base09: normalizePaletteValue(rawPalette.base09, fileName, "base09"),
    base0A: normalizePaletteValue(rawPalette.base0A, fileName, "base0A"),
    base0B: normalizePaletteValue(rawPalette.base0B, fileName, "base0B"),
    base0C: normalizePaletteValue(rawPalette.base0C, fileName, "base0C"),
    base0D: normalizePaletteValue(rawPalette.base0D, fileName, "base0D"),
    base0E: normalizePaletteValue(rawPalette.base0E, fileName, "base0E"),
    base0F: normalizePaletteValue(rawPalette.base0F, fileName, "base0F"),
  };
}

function normalizePaletteValue(value: unknown, fileName: string, key: Base16Key): string {
  if (!isValidHexColor(value)) {
    throw new Error(`Theme ${fileName} has an invalid ${key} value.`);
  }

  return normalizeHex(value);
}

function parseTheme(path: string, raw: string): Base16Theme {
  const fileName = path.split("/").pop() ?? path;
  const id = fileName.replace(/\.(yaml|yml)$/i, "");
  const document = yaml.load(raw) as RawThemeDocument;
  const name = typeof document?.name === "string" && document.name.trim() ? document.name.trim() : id;
  const author = typeof document?.author === "string" && document.author.trim()
    ? document.author.trim()
    : "Unknown";
  const variant = document?.variant === "light" ? "light" : "dark";

  return {
    id,
    fileName,
    name,
    author,
    variant,
    palette: parsePalette(document?.palette, fileName),
    raw,
  };
}

function hexToRgbTriplet(hex: string): string {
  const normalized = hex.replace(/^#/, "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `${red} ${green} ${blue}`;
}

export const BASE16_THEMES = Object.entries(rawThemeModules)
  .map(([path, raw]) => parseTheme(path, raw))
  .sort((left, right) => left.name.localeCompare(right.name));

export const DEFAULT_THEME_ID = "matrix";

export function getThemeById(themeId: string | null | undefined): Base16Theme | null {
  if (!themeId) {
    return null;
  }

  return BASE16_THEMES.find((theme) => theme.id === themeId) ?? null;
}

export function getThemeCssVariables(theme: Base16Theme): Record<string, string> {
  const variables: Record<string, string> = {
    "--terminal-drawer-stowed-height": "52px",
    "--terminal-drawer-page-gap": "24px",
  };

  for (const key of REQUIRED_BASE_KEYS) {
    variables[`--${key}`] = theme.palette[key];
    variables[`--rgb-${key}`] = hexToRgbTriplet(theme.palette[key]);
  }

  return variables;
}
