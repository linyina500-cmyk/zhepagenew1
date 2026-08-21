export type LayoutStyleKey =
  | "xiaohongshu"
  | "financeDeepRead"
  | "dataIndex"
  | "cleanNews"
  | "keyCards";

export type PreviewPresentation = "beautified" | "base";

export type LayoutPreset = {
  key: LayoutStyleKey;
  name: string;
  detail: string;
  recommended?: boolean;
  coverLabel: string;
  coverBadge: string;
  typeScale: number;
  lineHeight: number;
  bottomReserve: number;
};

export type ThemeSource = {
  paper: string;
  text: string;
  accent: string;
  highlight: string;
};

export type ResolvedThemeTokens = ThemeSource & {
  onAccent: string;
  mutedText: string;
  softAccent: string;
  softerAccent: string;
  borderAccent: string;
};
