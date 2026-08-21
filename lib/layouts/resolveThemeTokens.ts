import type { ResolvedThemeTokens, ThemeSource } from "./layoutTypes";

function rgbFromHex(value: string) {
  const compact = value.trim().replace(/^#/, "");
  const normalized = compact.length === 3
    ? compact.split("").map((character) => character.repeat(2)).join("")
    : compact;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
}

function relativeLuminance(value: string) {
  const rgb = rgbFromHex(value);
  if (!rgb) return 0;
  const [red, green, blue] = rgb.map((channel) => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function resolveThemeTokens(theme: ThemeSource): ResolvedThemeTokens {
  return {
    ...theme,
    onAccent: relativeLuminance(theme.accent) > 0.42 ? "#151515" : "#ffffff",
    mutedText: `color-mix(in srgb, ${theme.text} 58%, ${theme.paper})`,
    softAccent: `color-mix(in srgb, ${theme.accent} 10%, ${theme.paper})`,
    softerAccent: `color-mix(in srgb, ${theme.accent} 5%, ${theme.paper})`,
    borderAccent: `color-mix(in srgb, ${theme.accent} 24%, ${theme.paper})`,
  };
}
