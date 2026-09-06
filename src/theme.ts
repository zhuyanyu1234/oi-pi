// Catppuccin Mocha 调色板：仅用于自绘行；pi 组件内部主题仍走 getMarkdownTheme() 等
export const palette = {
  mauve: "#cba6f7", // 强调 · assistant
  teal: "#94e2d5", // 强调 · user
  green: "#a6e3a1",
  yellow: "#f9e2af",
  red: "#f38ba8",
  text: "#cdd6f4",
  overlay1: "#7f849c", // 次要文字
  surface2: "#585b70", // 最弱文字
  surface1: "#45475a", // 边框 / 状态栏底色
  surface0: "#313244", // 面板
  base: "#1e1e2e",
} as const;

const rgbOf = (hexColor: string): [number, number, number] => {
  const n = parseInt(hexColor.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const fgc = (hexColor: string, text: string) => {
  const [r, g, b] = rgbOf(hexColor);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
};

export const fg = {
  accent: (s: string) => fgc(palette.mauve, s),
  accent2: (s: string) => fgc(palette.teal, s),
  success: (s: string) => fgc(palette.green, s),
  warning: (s: string) => fgc(palette.yellow, s),
  error: (s: string) => fgc(palette.red, s),
  text: (s: string) => fgc(palette.text, s),
  muted: (s: string) => fgc(palette.overlay1, s),
  dim: (s: string) => fgc(palette.surface2, s),
  border: (s: string) => fgc(palette.surface1, s),
};

export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
