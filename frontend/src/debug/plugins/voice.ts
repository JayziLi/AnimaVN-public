/**
 * 语音插件的纯函数:插件配置、哪句念、用哪个声音、念什么字、什么情绪。
 *
 * 语音不加提示词、不加标签:说话人来自切句(vn/script.ts),情绪来自这句生效的立绘表情
 * (匹配之后的名字,见 plugins/emotionMatch.ts)。
 * 声音、情绪表、卡的绑定在后端(app/api/voices.py),合成走 /api/tts/speak(有缓存)。
 * 规则见 docs/superpowers/specs/2026-09-24-vn-voice-design.md。
 */

import type {
  EmoMode,
  SpeakRequest,
  TextSplitMethod,
  TtsApiType,
  TtsConnection,
  VoiceParams,
  VoiceProfile,
} from '../lib/api';
import type { TagHit, VNLine } from '../vn/script';
import { isNpcHit, type EmotionContext } from './emotionMatch';
import { isJaLang, speechText } from './lang';

export const VOICE_SETTING_KEY = 'plugin.voice';

export interface VoicePluginConfig {
  /** 总开关 */
  enabled: boolean;
  /** 翻到一句要念的台词时,等语音好了文字和声音一起出 */
  waitForVoice: boolean;
  /** 等语音最多等几秒;超时先出文字,语音好了再补上 */
  maxWaitSec: number;
  /** 情绪不变:主声音每句都用情绪表排第一的那行(默认情绪),不跟着立绘表情换 */
  fixedEmotion: boolean;
}

export const DEFAULT_VOICE_CONFIG: VoicePluginConfig = {
  enabled: true,
  // 默认不等:文字直接出,语音在后台合成,好了就念(对话框里文字后面转个圈表示还在合成)
  waitForVoice: false,
  maxWaitSec: 3,
  fixedEmotion: false,
};

export const MAX_WAIT_MIN = 1;
export const MAX_WAIT_MAX = 10;

export function normalizeVoiceConfig(raw: unknown): VoicePluginConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_VOICE_CONFIG;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    waitForVoice: typeof r.waitForVoice === 'boolean' ? r.waitForVoice : d.waitForVoice,
    maxWaitSec:
      typeof r.maxWaitSec === 'number' && Number.isFinite(r.maxWaitSec)
        ? Math.min(MAX_WAIT_MAX, Math.max(MAX_WAIT_MIN, Math.round(r.maxWaitSec)))
        : d.maxWaitSec,
    fixedEmotion: typeof r.fixedEmotion === 'boolean' ? r.fixedEmotion : d.fixedEmotion,
  };
}

/** 这张卡能用的声音:主声音念角色自己的台词,其他的按说话人名字对上才念 */
export interface VoiceCast {
  main: VoiceProfile | null;
  extras: VoiceProfile[];
}

export function castOf(
  profiles: readonly VoiceProfile[],
  main: string | null,
  extras: readonly string[],
): VoiceCast {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return {
    main: (main && byId.get(main)) || null,
    extras: extras.map((id) => byId.get(id)).filter((p): p is VoiceProfile => Boolean(p)),
  };
}

/**
 * 说话人 → 声音。旁白(null)不念;说话人就是这张卡的角色名(切句没认出「名字：」时
 * 用的就是它)→ 主声音;否则按名字 / 别名找,不分大小写,找不到不念
 */
export function voiceForSpeaker(
  speaker: string | null,
  charName: string,
  cast: VoiceCast,
): VoiceProfile | null {
  if (!speaker) return null;
  if (speaker === charName) return cast.main;
  const key = speaker.trim().toLowerCase();
  const pool = cast.main ? [cast.main, ...cast.extras] : cast.extras;
  return (
    pool.find((p) => p.name.toLowerCase() === key || p.aliases.some((a) => a.toLowerCase() === key)) ??
    null
  );
}

/** 念之前的清理:括号里的动作、*动作*、各种引号都不念 */
export function cleanSpeech(text: string): string {
  return text
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/\*[^*]*\*/g, '')
    .replace(/[*「」『』“”"‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 只剩标点和空白就没什么可念的(api_v2 也会报「请输入有效文本」) */
export const hasSpeakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

/**
 * 和立绘层同一套算法:从 start 开始,一串立绘标签依次生效之后是哪个表情名。
 * 匹配到的(精确或模型)就切;还在问、模型不可用的保持上一个 —— 这张卡没立绘时,
 * 模型不可用就用标签里的原词。NPC 台词前的标签不算
 */
export function spriteLabelAfter(
  hits: readonly TagHit[],
  ctx: EmotionContext,
  start: string | null,
): string | null {
  let label = start;
  for (const h of hits) {
    if (h.kind !== 'sprite' || isNpcHit(h, ctx.charName)) continue;
    const m = ctx.resolve(h.label);
    if (m.state === 'exact' || m.state === 'model') label = m.label;
    else if (m.state === 'failed' && ctx.rawOnFail) label = h.label;
  }
  return label;
}

/**
 * 当前这条回复里每一句怎么念;不念的是 null。
 * 主声音的情绪 = 这句生效的表情(匹配之后的名字);其他声音不传情绪(用它们的默认情绪)。
 * 影响这句的标签还在问模型时先不念(和流式没写完一样),免得用错的情绪合成进缓存。
 * 设置里选了情绪不变时,主声音也不传情绪,也就不用等模型
 */
export function planVoiceLines(o: {
  lines: readonly VNLine[];
  /** 这条回复的标签 */
  hits: readonly TagHit[];
  /** 这条回复第一句之前生效的表情(之前各条回复的立绘标签累计下来的) */
  emotionBefore: string | null;
  ctx: EmotionContext;
  cast: VoiceCast;
  /** 流式时最后一句还在写,写完才念 */
  streaming: boolean;
  /** 情绪不变(插件设置) */
  fixedEmotion: boolean;
}): (SpeakRequest | null)[] {
  return o.lines.map((ln, i) => {
    if (o.streaming && i === o.lines.length - 1) return null;
    // 玩家台词不念(就算碰巧有个声音和玩家同名)
    if (ln.player) return null;
    const profile = voiceForSpeaker(ln.speaker, o.ctx.charName, o.cast);
    if (!profile) return null;
    // 外语插件:日语声音念这句上面那行日语,缺日语不念;中文声音照旧念中文
    const said = speechText(ln, profile.text_lang);
    if (said === null) return null;
    const text = cleanSpeech(said);
    if (!hasSpeakable(text)) return null;
    if (o.fixedEmotion || profile.id !== o.cast.main?.id) return { profile_id: profile.id, emotion: null, text };
    const upTo = spriteHitsUpTo(o.hits, i, o.ctx.charName);
    if (upTo.some((h) => o.ctx.resolve(h.label).state === 'pending')) return null;
    return { profile_id: profile.id, emotion: spriteLabelAfter(upTo, o.ctx, o.emotionBefore), text };
  });
}

/** 这条回复里到第 i 句为止生效的立绘标签(NPC 台词前的不算),决定这句的情绪 */
export const spriteHitsUpTo = (hits: readonly TagHit[], i: number, charName: string) =>
  hits.filter((h) => h.kind === 'sprite' && h.lineIndex !== -1 && h.lineIndex <= i && !isNpcHit(h, charName));

/**
 * planVoiceLines 给了 null 的句子为什么不念(控制台和历史里的语音详情用)。
 * profile 是 voiceForSpeaker 的结果;streamingLast:流式时这条的最后一句;
 * pendingTag:影响这句的立绘标签还在等模型认表情
 */
export function voiceSkipReason(
  ln: VNLine,
  profile: VoiceProfile | null,
  o: { streamingLast: boolean; pendingTag: boolean },
): string {
  if (ln.player) return '玩家台词,不念';
  if (ln.untagged) return '没写立绘标签,不算角色的台词,不念';
  if (!ln.speaker) return '旁白,不念';
  if (!profile) return `没有「${ln.speaker}」的声音`;
  if (o.streamingLast) return '还在写,写完再念';
  if (speechText(ln, profile.text_lang) === null) {
    return isJaLang(profile.text_lang) ? '缺日语,没念' : '只有日语,中文声音不念';
  }
  if (o.pendingTag) return '立绘标签还在等模型认表情,认完再念';
  return '没有可念的字';
}

/** 同样的声音 + 情绪 + 文字就是同一段语音(后端也按这些缓存) */
export const voiceKey = (r: SpeakRequest) => `${r.profile_id}\u0000${r.emotion ?? ''}\u0000${r.text}`;

/** 参考音频按「【情绪】原文.wav」命名时,取出情绪名和原文 */
export function parseRefFileName(path: string): { label: string; text: string } | null {
  const name = path.trim().replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? '';
  const m = /^【([^】]+)】(.+)\.[A-Za-z0-9]+$/.exec(name);
  return m ? { label: m[1].trim(), text: m[2].trim() } : null;
}

/** 这张卡的表情(没立绘时是内置基础表情)里,哪些在主声音的情绪表里对不上(会用默认情绪念) */
export function missingEmotions(labels: readonly string[], profile: VoiceProfile | null): string[] {
  if (!profile) return [];
  const names = new Set(
    profile.emotions.flatMap((e) => [e.label, ...e.aliases]).map((n) => n.toLowerCase()),
  );
  return labels.filter((l) => !names.has(l.toLowerCase()));
}

// ---- IndexTTS 的情绪向量 ----

/** 8 维的顺序是 IndexTTS 官方定的;short 用在编辑器的小标签上 */
export const EMO_DIMS = [
  { short: '喜', name: '高兴' },
  { short: '怒', name: '愤怒' },
  { short: '哀', name: '悲伤' },
  { short: '惧', name: '害怕' },
  { short: '厌', name: '厌恶' },
  { short: '郁', name: '忧郁' },
  { short: '惊', name: '惊讶' },
  { short: '平', name: '平静' },
] as const;
export const EMO_DIM_MAX = 1.2;
export const EMO_SUM_MAX = 1.5;

/** 和后端 clean_emo_vector 同一套规则;没问题返回 null */
export function emoVectorProblem(v: readonly number[]): string | null {
  if (v.length !== EMO_DIMS.length) return `要正好 ${EMO_DIMS.length} 个数`;
  for (let i = 0; i < v.length; i++) {
    if (!(v[i] >= 0 && v[i] <= EMO_DIM_MAX)) return `「${EMO_DIMS[i].name}」要在 0 到 ${EMO_DIM_MAX} 之间`;
  }
  const total = v.reduce((a, b) => a + b, 0);
  if (total > EMO_SUM_MAX + 1e-9) return `合计 ${total.toFixed(2)},不能超过 ${EMO_SUM_MAX}`;
  return null;
}

export const EMO_MODE_TEXT: Record<EmoMode, string> = { ref: '参考', vector: '向量', none: '不控制' };

// ---- 合成参数(存在声音上;插件页的试音台里调) ----

/** 决定一个声音念出来什么样的全部设置。变了,之前合成好、还留在内存里的句子就作废 */
export function voiceSignature(p: VoiceProfile, connections: readonly TtsConnection[]): string {
  const c = connections.find((x) => x.id === p.connection_id);
  return JSON.stringify([
    [p.connection_id, p.gpt_weights, p.sovits_weights, p.ref_path, p.text_lang, p.speed, p.params],
    p.emotions.map((e) => [e.label, e.aliases, e.ref_path, e.prompt_text, e.emo_vector]),
    c ? [c.base_url, c.api_type, c.sample_steps, c.emo_alpha] : null,
  ]);
}

type NumKey = {
  [K in keyof VoiceParams]-?: NonNullable<VoiceParams[K]> extends number ? K : never;
}[keyof VoiceParams];

export interface NumParam {
  key: NumKey;
  name: string;
  min: number;
  max: number;
  step: number;
  /** 引擎自己的默认;null = 跟语音服务(采样步数、情绪强度) */
  def: number | null;
  unit?: string;
  note: string;
}

/** GPT-SoVITS api_v2 能调的数值参数。默认值是台式机上 api_v2.py 里的(2026-09-25 核对) */
export const GSV_NUM_PARAMS: NumParam[] = [
  {
    key: 'sample_steps',
    name: '采样步数',
    min: 8,
    max: 128,
    step: 8,
    def: null,
    note: '越多越细、越慢(64 步一句约 1.2 秒,32 步约 0.8 秒)',
  },
  {
    key: 'temperature',
    name: '温度',
    min: 0.05,
    max: 1.5,
    step: 0.05,
    def: 1,
    note: '低 = 稳、平淡;高 = 起伏大,也更容易念错、吞字',
  },
  {
    key: 'top_p',
    name: 'top_p',
    min: 0.05,
    max: 1,
    step: 0.05,
    def: 1,
    note: '只在最可能的那部分发音里挑;调低更稳',
  },
  {
    key: 'top_k',
    name: 'top_k',
    min: 1,
    max: 100,
    step: 1,
    def: 15,
    note: '只在最可能的前 k 个里挑;调低更稳、更单调',
  },
  {
    key: 'repetition_penalty',
    name: '重复惩罚',
    min: 1,
    max: 2,
    step: 0.05,
    def: 1.35,
    note: '防止卡在同一个音上反复念;太高会念得怪',
  },
  {
    key: 'fragment_interval',
    name: '句间停顿',
    min: 0.05,
    max: 1,
    step: 0.05,
    def: 0.3,
    unit: '秒',
    note: '按标点切开的几段之间停多久',
  },
];

/** IndexTTS 只有情绪强度可调(小服务的接口就这些) */
export const INDEX_NUM_PARAMS: NumParam[] = [
  {
    key: 'emo_alpha',
    name: '情绪强度',
    min: 0,
    max: 1,
    step: 0.05,
    def: null,
    note: '情绪向量 / 情绪参考的效果乘上它;听着偏弱时先调这个',
  },
];

export const SPEED_RANGE = { min: 0.5, max: 2, step: 0.05 };

export const TEXT_SPLIT_METHODS: { value: TextSplitMethod; name: string }[] = [
  { value: 'cut5', name: '按标点切' },
  { value: 'cut0', name: '不切' },
  { value: 'cut1', name: '每四句一段' },
  { value: 'cut2', name: '每 50 字一段' },
  { value: 'cut3', name: '按中文句号切' },
  { value: 'cut4', name: '按英文句号切' },
];

/** 要念的文字是什么语言。参考音频的语言由后端按原文自动判断,不用选 */
export const VOICE_LANGS: Record<TtsApiType, { value: string; name: string }[]> = {
  gpt_sovits: [
    { value: 'zh', name: '中文' },
    { value: 'ja', name: '日语' },
    { value: 'en', name: '英语' },
    { value: 'yue', name: '粤语' },
    { value: 'ko', name: '韩语' },
    { value: 'auto', name: '自动(多语混合)' },
  ],
  indextts: [
    { value: 'zh', name: '中文' },
    { value: 'ja', name: '日语' },
    { value: 'en', name: '英语' },
  ],
};

/** 试音台里正在调的那一组:整组保存到声音上 */
export interface VoiceDraft {
  speed: number;
  text_lang: string;
  params: VoiceParams;
}

export const draftOf = (p: VoiceProfile): VoiceDraft => ({
  speed: p.speed,
  text_lang: p.text_lang || 'zh',
  params: { ...p.params },
});

/** 参数按键排好再比,调过又调回默认(删掉那一项)也算没改 */
const paramsText = (p: VoiceParams) =>
  JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));

export const sameDraft = (a: VoiceDraft, b: VoiceDraft) =>
  a.speed === b.speed && a.text_lang === b.text_lang && paramsText(a.params) === paramsText(b.params);

const trimNum = (n: number) => String(Number(n.toFixed(2)));

/** 这组和默认不一样的地方,一句话:语速 1.1 · 温度 0.7 · 不切。全是默认返回空串 */
export function draftSummary(d: VoiceDraft, engine: TtsApiType): string {
  const parts: string[] = [];
  if (d.speed !== 1) parts.push(`语速 ${trimNum(d.speed)}`);
  if (d.text_lang !== 'zh') {
    parts.push(VOICE_LANGS[engine].find((l) => l.value === d.text_lang)?.name ?? d.text_lang);
  }
  for (const p of engine === 'indextts' ? INDEX_NUM_PARAMS : GSV_NUM_PARAMS) {
    const v = d.params[p.key];
    if (v !== undefined) parts.push(`${p.name} ${trimNum(v)}${p.unit ?? ''}`);
  }
  if (engine === 'gpt_sovits') {
    const split = d.params.text_split_method;
    if (split && split !== 'cut5') parts.push(TEXT_SPLIT_METHODS.find((m) => m.value === split)?.name ?? split);
    if (d.params.parallel_infer === false) parts.push('关并行推理');
  }
  return parts.join(' · ');
}

// ---- 试听例句(试音台、情绪表里的 ▶) ----

export type SampleLang = 'zh' | 'ja';

/** 常用试听句:中文、日文各一套,同一个下标是同一句话 */
export const VOICE_SAMPLES: Record<SampleLang, { name: string; text: string }[]> = {
  zh: [
    { name: '日常', text: '你好，今天过得怎么样？我一直在等你。' },
    { name: '开心', text: '太好了！我就知道你一定可以做到的！' },
    { name: '难过', text: '……没关系的，我一个人也可以。你不用担心我。' },
    { name: '惊讶', text: '诶？！真的吗？你什么时候回来的？' },
    { name: '生气', text: '你到底有没有在听我说话啊！' },
    {
      name: '长句',
      text: '其实我一直想告诉你，那天在车站分开之后，我每天都会想起你说过的话。虽然不知道你还记不记得，但对我来说，那是很重要的约定。',
    },
  ],
  ja: [
    { name: '日常', text: 'おかえりなさい。今日はどうだった？ずっと待ってたんだよ。' },
    { name: '开心', text: 'やった！絶対できるって信じてたよ！' },
    { name: '难过', text: '……大丈夫。一人でも平気だから、心配しないで。' },
    { name: '惊讶', text: 'えっ？！本当に？いつ帰ってきたの？' },
    { name: '生气', text: 'ちょっと、ちゃんと話聞いてるの？' },
    {
      name: '长句',
      text: '実はずっと言いたかったんだ。あの日駅で別れてから、あなたの言葉を毎日思い出してた。覚えてるかわからないけど、私にとっては大切な約束なんだ。',
    },
  ],
};

export const DEFAULT_VOICE_SAMPLE = VOICE_SAMPLES.zh[0].text;

/** 声音念的语言 → 用哪套例句:日语用日文的,其他(中文、自动……)用中文的 */
export const sampleLangOf = (textLang: string): SampleLang => (textLang === 'ja' ? 'ja' : 'zh');

/**
 * 文本是内置例句的话,换成同一句的另一种语言;自己写的句子原样返回。
 * 换声音时用:日语声音别去念框里剩下的中文例句
 */
export function sampleIn(text: string, lang: SampleLang): string {
  const t = text.trim();
  for (const list of Object.values(VOICE_SAMPLES)) {
    const i = list.findIndex((s) => s.text === t);
    if (i !== -1) return VOICE_SAMPLES[lang][i].text;
  }
  return text;
}
