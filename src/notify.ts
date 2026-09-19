// 长任务完成提醒：BEL 响铃 + OSC 9 桌面通知（不识别 OSC 9 的终端会静默忽略）。
// OI_PI_NOTIFY=0 关闭；bell 是否可见取决于终端的「响铃/闪烁」设置。
export const NOTIFY_DISABLED = process.env.OI_PI_NOTIFY === "0";

export function notifyDone(message: string): void {
  if (NOTIFY_DISABLED) return;
  const clean = message.replace(/[\x00-\x1f\x07]/g, "").slice(0, 60);
  process.stdout.write(`\x1b]9;oi-pi · ${clean}\x07\x07`);
}
