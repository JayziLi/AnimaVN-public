/**
 * 视觉小说自己的偏好:文字速度、自动播放、文本框透明度……纯前端,按设备记住。
 *
 * 回车键和调试台聊天框共用,存在 chatSettings 里;BGM 音量归播放器管(bgm.ts)。
 * 这里只放视觉小说独有的。读的时候逐字段校验再和默认值合并,手改坏了也不会炸。
 */

export interface VNSettings {
  /** 打字机每个字的间隔(毫秒);0 = 整句直接出 */
  textSpeed: number;
  /** 自动播放时,一句打完之后停多久再翻下一句(毫秒) */
  autoDelay: number;
  /** 对话框底色的不透明度 */
  boxOpacity: number;
  /** 对白字号倍率 */
  textScale: number;
  /** 对话框里显示思考过程(思考中的计时块、回复第一句上的「已思考」) */
  showThinking: boolean;
  /** 右上角显示当前模型 */
  showModel: boolean;
  /** 进视觉小说先看标题画面;关掉就直接接着上次的对话 */
  titleScreen: boolean;
  /** 翻页时停掉上一句的语音;关掉 = 上一句接着念,直到这句的语音开始 */
  voiceInterrupt: boolean;
  /** 自动播放时等这句的语音合成完、念完再翻 */
  autoWaitVoice: boolean;
  /** 念台词时 BGM 压到原音量的多少(1 = 不压) */
  duckLevel: number;
}

const KEY = 'anima.vn.settings';

export const DEFAULT_VN_SETTINGS: VNSettings = {
  textSpeed: 28,
  autoDelay: 1500,
  boxOpacity: 0.72,
  textScale: 1,
  showThinking: true,
  showModel: true,
  titleScreen: true,
  voiceInterrupt: true,
  autoWaitVoice: true,
  duckLevel: 0.35,
};

export const TEXT_SPEEDS: { value: number; name: string }[] = [
  { value: 60, name: '慢' },
  { value: 28, name: '中' },
  { value: 14, name: '快' },
  { value: 0, name: '瞬间' },
];

export const DUCK_LEVELS: { value: number; name: string }[] = [
  { value: 1, name: '不压低' },
  { value: 0.6, name: '压低一点' },
  { value: 0.35, name: '压低' },
  { value: 0.12, name: '几乎听不见' },
];

export const AUTO_MIN = 500;
export const AUTO_MAX = 5000;
export const OPACITY_MIN = 0.2;
export const SCALE_MIN = 0.85;
export const SCALE_MAX = 1.3;

function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function loadVNSettings(): VNSettings {
  const d = DEFAULT_VN_SETTINGS;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    // 存坏了就当没存过
  }
  return {
    textSpeed: num(raw.textSpeed, 0, 200, d.textSpeed),
    autoDelay: num(raw.autoDelay, AUTO_MIN, AUTO_MAX, d.autoDelay),
    boxOpacity: num(raw.boxOpacity, OPACITY_MIN, 1, d.boxOpacity),
    textScale: num(raw.textScale, SCALE_MIN, SCALE_MAX, d.textScale),
    showThinking: bool(raw.showThinking, d.showThinking),
    showModel: bool(raw.showModel, d.showModel),
    titleScreen: bool(raw.titleScreen, d.titleScreen),
    voiceInterrupt: bool(raw.voiceInterrupt, d.voiceInterrupt),
    autoWaitVoice: bool(raw.autoWaitVoice, d.autoWaitVoice),
    duckLevel: num(raw.duckLevel, 0, 1, d.duckLevel),
  };
}

export function saveVNSettings(s: VNSettings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 隐私模式等写不进去:这次会话里照样生效,只是不记住
  }
}
