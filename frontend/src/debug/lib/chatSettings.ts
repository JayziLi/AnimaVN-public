/**
 * 聊天区的显示偏好 —— 纯前端的「我的眼睛怎么舒服」,不进数据库。
 *
 * 整个对象存一个 localStorage 键。读的时候逐字段校验再和默认值合并,
 * 这样以后加字段、或者用户手改坏了值,都不会把界面炸掉。
 */

export type ChatLayout = 'bubble' | 'duo' | 'document' | 'compact' | 'script';
export type AvatarShape = 'rounded' | 'square' | 'circle';
/** 回车键在输入框里干什么。auto = 硬件键盘 Enter 发送、手机软键盘 Enter 换行 */
export type EnterKeyMode = 'auto' | 'send' | 'newline';

export interface ChatSettings {
  layout: ChatLayout;
  /**
   * 消息块的字号倍率,1 = 正文 13px。
   * 正文、昵称、模型元信息一起缩放 —— 只放大正文会让整块比例失衡,
   * 这是酒馆 (--fontScale 挂在 body 上) 和 Discord 的共同做法。
   */
  fontScale: number;
  lineHeight: number;
  /** 消息列的最大宽度(px);0 = 不限,铺满聊天区 */
  chatWidth: number;
  /** 头像边长(px)。和字号分开 —— Discord 的 Zoom 与 Font Scaling 也是两条 */
  avatarSize: number;
  avatarShape: AvatarShape;
  highlightQuotes: boolean;
  quoteColor: string;
  /** 调试台聊天框和视觉小说输入框共用 */
  enterKey: EnterKeyMode;
}

const KEY = 'debug.chatSettings';

export const LAYOUTS: { key: ChatLayout; name: string; note: string }[] = [
  { key: 'bubble', name: '气泡', note: '头像在左,正文是一个带边框的块' },
  { key: 'duo', name: '对向', note: '你的话靠右、角色靠左,像即时通讯' },
  { key: 'document', name: '文档', note: '去掉头像与框线,只靠留白断句,适合长文连读' },
  { key: 'compact', name: '紧凑', note: '小头像、间距收紧,一屏能塞下更多条' },
  { key: 'script', name: '剧本', note: '无头像;名字做成名牌,正文缩进挂一道竖线' },
];

/** 上下限对齐酒馆的 Font Scale (0.5~1.5) 与 Discord 的 12~24px */
export const FONT_MIN = 0.75;
export const FONT_MAX = 1.6;
export const FONT_STEP = 0.05;

export const AVATAR_MIN = 24;
export const AVATAR_MAX = 72;
export const AVATAR_STEP = 4;

export const AVATAR_SHAPES: { value: AvatarShape; name: string; radius: string }[] = [
  { value: 'rounded', name: '圆角', radius: '5px' },
  { value: 'square', name: '方', radius: '0' },
  { value: 'circle', name: '圆', radius: '50%' },
];

export const LINE_HEIGHTS: { value: number; name: string }[] = [
  { value: 1.5, name: '紧凑' },
  { value: 1.7, name: '标准' },
  { value: 1.9, name: '宽松' },
];

/** 对应酒馆的 Chat Width。这里给固定几档,比百分比滑块好挑 */
export const CHAT_WIDTHS: { value: number; name: string }[] = [
  { value: 640, name: '窄' },
  { value: 760, name: '标准' },
  { value: 960, name: '宽' },
  { value: 0, name: '满宽' },
];

/** 引号色板。主题本身是纯灰阶,这里是继 --danger 之后第二处破例用色相 */
export const QUOTE_COLORS: { value: string; name: string }[] = [
  { value: '#d8a657', name: '暖黄' },
  { value: '#7fbfbf', name: '青' },
  { value: '#e08aa0', name: '玫红' },
  { value: '#b3a0e0', name: '淡紫' },
  { value: '#ffffff', name: '中性亮' },
];

export const ENTER_KEY_MODES: { value: EnterKeyMode; name: string; note: string }[] = [
  {
    value: 'auto',
    name: '自动',
    note: '电脑上 Enter 发送、Shift+Enter 换行;手机软键盘上 Enter 换行,点按钮发送',
  },
  { value: 'send', name: 'Enter 发送', note: 'Enter 发送,Shift+Enter 换行(手机上也这样)' },
  { value: 'newline', name: 'Enter 换行', note: 'Enter 换行,Ctrl+Enter(Mac 上 ⌘+Enter)或点按钮发送' },
];

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  layout: 'bubble',
  fontScale: 1,
  lineHeight: 1.7,
  chatWidth: 760,
  avatarSize: 36,
  avatarShape: 'rounded',
  highlightQuotes: true,
  quoteColor: QUOTE_COLORS[0].value,
  enterKey: 'auto',
};

const isLayout = (v: unknown): v is ChatLayout => LAYOUTS.some((l) => l.key === v);

/** 落在 [min,max] 里、且对得上步长的数才算数;否则退回默认值 */
function clampStep(raw: unknown, min: number, max: number, step: number, fallback: number) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.round((n - min) / step) * step + min;
}

export function avatarRadius(shape: AvatarShape): string {
  return AVATAR_SHAPES.find((s) => s.value === shape)?.radius ?? '5px';
}

/** 全都还是出厂值 —— 「恢复默认」据此变灰,没什么可恢复的时候不给点 */
export function isDefaultChatSettings(s: ChatSettings): boolean {
  return (Object.keys(DEFAULT_CHAT_SETTINGS) as (keyof ChatSettings)[]).every(
    (k) => s[k] === DEFAULT_CHAT_SETTINGS[k],
  );
}

export function loadChatSettings(): ChatSettings {
  let raw: unknown;
  try {
    const text = window.localStorage.getItem(KEY);
    if (text === null) return DEFAULT_CHAT_SETTINGS;
    raw = JSON.parse(text);
  } catch {
    // 手改坏了 / 存了半截:当没设过
    return DEFAULT_CHAT_SETTINGS;
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_CHAT_SETTINGS;
  const o = raw as Partial<Record<keyof ChatSettings, unknown>>;

  const line = Number(o.lineHeight);

  return {
    layout: isLayout(o.layout) ? o.layout : DEFAULT_CHAT_SETTINGS.layout,
    fontScale: clampStep(
      o.fontScale,
      FONT_MIN,
      FONT_MAX,
      FONT_STEP,
      DEFAULT_CHAT_SETTINGS.fontScale,
    ),
    lineHeight: LINE_HEIGHTS.some((l) => l.value === line)
      ? line
      : DEFAULT_CHAT_SETTINGS.lineHeight,
    chatWidth: CHAT_WIDTHS.some((w) => w.value === Number(o.chatWidth))
      ? Number(o.chatWidth)
      : DEFAULT_CHAT_SETTINGS.chatWidth,
    avatarSize: clampStep(
      o.avatarSize,
      AVATAR_MIN,
      AVATAR_MAX,
      AVATAR_STEP,
      DEFAULT_CHAT_SETTINGS.avatarSize,
    ),
    avatarShape: AVATAR_SHAPES.some((s) => s.value === o.avatarShape)
      ? (o.avatarShape as AvatarShape)
      : DEFAULT_CHAT_SETTINGS.avatarShape,
    highlightQuotes:
      typeof o.highlightQuotes === 'boolean'
        ? o.highlightQuotes
        : DEFAULT_CHAT_SETTINGS.highlightQuotes,
    quoteColor: QUOTE_COLORS.some((c) => c.value === o.quoteColor)
      ? (o.quoteColor as string)
      : DEFAULT_CHAT_SETTINGS.quoteColor,
    enterKey: ENTER_KEY_MODES.some((m) => m.value === o.enterKey)
      ? (o.enterKey as EnterKeyMode)
      : DEFAULT_CHAT_SETTINGS.enterKey,
  };
}

/**
 * 输入框里这一下回车该不该发送。不发送时由浏览器照常换行。
 *   - 输入法选字时的回车是「确认候选词」,一律不算
 *   - Ctrl / ⌘ + Enter 在任何模式下都是发送(手机接了蓝牙键盘也能用)
 *   - softKeyboard:没有 Shift 可按,auto 模式下回车只能当换行
 */
export function enterShouldSend(
  e: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    nativeEvent: { isComposing: boolean };
  },
  mode: EnterKeyMode,
  softKeyboard: boolean,
): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return true;
  if (mode === 'newline') return false;
  if (mode === 'auto' && softKeyboard) return false;
  return !e.shiftKey;
}

/** 输入框占位符里的按键提示;手机 + 自动模式下不提(软键盘的回车各家行为不一) */
export function enterHint(mode: EnterKeyMode, softKeyboard: boolean): string {
  if (mode === 'newline') return 'Enter 换行,Ctrl+Enter 发送';
  if (mode === 'auto' && softKeyboard) return '';
  return 'Enter 发送,Shift+Enter 换行';
}

export function saveChatSettings(value: ChatSettings): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
}
