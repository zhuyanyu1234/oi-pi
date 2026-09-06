// 极简调色板：取自 pi dark 主题的同名色值，只用于自绘行；组件内部主题走 getMarkdownTheme() 等
const rgb = (hexColor: string, text: string) => {
  const n = parseInt(hexColor.slice(1), 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
};

export const fg = {
  accent: (s: string) => rgb("#8abeb7", s),
  border: (s: string) => rgb("#5f87ff", s),
  success: (s: string) => rgb("#b5bd68", s),
  error: (s: string) => rgb("#cc6666", s),
  warning: (s: string) => rgb("#ffff00", s),
  muted: (s: string) => rgb("#808080", s),
  dim: (s: string) => rgb("#666666", s),
};

export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
