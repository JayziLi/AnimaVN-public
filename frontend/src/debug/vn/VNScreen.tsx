/**
 * 视觉小说界面 —— 同一段对话的另一种看法。
 *
 * 不持有任何对话数据:条目、发送、停止、重新生成全部来自调试台,这里只负责
 * 把 AI 回复切成一句一句,配上立绘、背景、对话框播出来。所以在这里发的消息,
 * 回到调试台也能看到,反过来也一样;提示词也走的是同一套组装流程。
 *
 * 局内菜单(历史 / 存档 / 角色 / 插件 / 预设 / 模型 / 设置 / 开发者)是一个全屏的壳,
 * 设置和开发者之外的页由调试台拼好传进来(renderPage),这两页在这里画。
 */

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import './vn.css';
import {
  sceneFileUrl,
  spriteImageUrl,
  type CardSprite,
  type SceneAsset,
  type SpeakRequest,
  type SpriteLayout,
} from '../lib/api';
import { currentInfo, currentText, type ChatEntry } from '../lib/chatEntry';
import { enterHint, enterShouldSend, type EnterKeyMode } from '../lib/chatSettings';
import { substituteMacros, type MacroContext } from '../lib/macros';
import { useCoarsePointer, useIsMobile } from '../lib/useIsMobile';
import { resolveByLabel } from '../plugins/common';
import { emotionCandidates, isNpcHit, type EmotionContext, type TagMatch } from '../plugins/emotionMatch';
import { parseBilingual } from '../plugins/lang';
import { facesByCanvas, spriteStyle, type SpriteStage } from '../plugins/spriteLayout';
import {
  applySceneTag,
  backgroundsOf,
  bgmsOf,
  initialScene,
  titleBgmOf,
  type SceneState,
} from '../plugins/scene';
import {
  EMO_MODE_TEXT,
  planVoiceLines,
  spriteHitsUpTo,
  spriteLabelAfter,
  voiceForSpeaker,
  voiceKey,
  voiceSkipReason,
  type VoiceCast,
  type VoicePluginConfig,
} from '../plugins/voice';
import { bgmPlayer } from './bgm';
import { Feather } from './Feather';
import type { ParsedReply, TagHit, TagKind, VNLine } from './script';
import { vnTagKinds } from './tags';
import { useEmotionMatches } from './useEmotionMatches';
import { useVoiceLine } from './useVoiceLine';
import type { ClipState } from './voice';
import { VoiceButtons } from './VoiceButtons';
import { VoiceDetail } from './VoiceDetail';
import type { PluginFocus, PluginSection } from '../components/PluginsDrawer';
import { VNMenu, type MenuPage } from './VNMenu';
import { VNSettingsPage } from './VNSettingsPage';
import { useVNAccent } from './accent';
import { VNTitle, type TitleCard, type TitleScene } from './VNTitle';
import { loadVNSettings, saveVNSettings, type VNSettings } from './vnSettings';

/** 卡没绑场景包、或者包里的背景还没传图时用的默认背景 */
const FALLBACK_BACKGROUND = '/vn/bg/uni.jpg';

/** 调试台拼好传进来的那几页 */
export type HostPage = Exclude<MenuPage, 'config' | 'dev'>;

export interface PageContext {
  close: () => void;
  /** 跳到某条回复的第一句,并关掉菜单 */
  jumpTo: (entryId: string) => void;
  /** 「在当前位置存档」存到哪条消息为止 */
  currentMessageId: string | null;
  /** 历史页的「显示原文」 */
  raw: boolean;
  /**
   * 历史页里一条 AI 回复的正文:按画面上的句子一句一句列,要念的句子带重播 / 重新生成。
   * 用户消息、还没切出句子的回复给 null(照原样显示)
   */
  lineView: (entry: ChatEntry) => ReactNode | null;
  /** 换到插件页的某个插件(预设里点了插件块、设置里点了「换声音」) */
  openPlugin: (section: PluginSection) => void;
  /** 插件页该停在哪个插件;从导航直接点进来时是 null */
  pluginFocus: PluginFocus | null;
}

interface Props {
  entries: ChatEntry[];
  /** 调试台聊天区用的同一份宏取值 —— 开场白里的 {{user}} 两边要展开成同一个人 */
  macros: MacroContext;
  charName: string;
  userName: string;
  sprites: CardSprite[];
  /** 立绘怎么摆:所有角色共用的构图 + 这张卡的微调 */
  spriteStage: SpriteStage;
  spriteLayout: SpriteLayout;
  tagTemplate: string;
  /** 这张卡绑的场景包里的素材(背景 + BGM);没绑时为空 */
  sceneAssets: SceneAsset[];
  /** 场景包设的封面音乐;null = 放排第一的 */
  titleBgmId: string | null;
  /** 设置页里改封面音乐:存在场景包上 */
  onChangeTitleBgm: (bgmId: string | null) => void;
  bgTemplate: string;
  bgmTemplate: string;
  /** 语音插件的配置,以及这张卡用哪些声音 */
  voiceConfig: VoicePluginConfig;
  voiceCast: VoiceCast;
  /** 设置页里改语音开关 / 等不等语音:改的是插件配置,和调试台插件抽屉同一份 */
  onChangeVoiceConfig: (next: VoicePluginConfig) => void;
  /** 外语插件:在中文上方显示这句的日语 */
  showJa: boolean;
  /** 回车键:和调试台的聊天框共用 */
  enterKey: EnterKeyMode;
  onChangeEnterKey: (mode: EnterKeyMode) => void;
  sending: boolean;
  /** 卡、预设都就绪才能发 */
  canSend: boolean;
  notReadyHint: string;
  /** 当前对话。换了(读档、新故事)就从最新一条回复的第一句开始看 */
  chatKey: string | null;
  chatName: string;
  /** 当前对话最后一次改动的时间 —— 标题画面上的「上次 · 3 小时前」 */
  chatUpdatedAt: string | null;
  /** 作品名(卡片的第一个标签),标题画面用 */
  cardTag: string | null;
  /** 正在读对话 —— 盖一层加载画面 */
  loading: boolean;
  /** 右上角的模型标签 */
  modelLabel: string;
  onSend: (text: string) => void;
  /**
   * 插话。entryId + keep:把这条回复截到 keep 为止(完整版留成另一个分支)再发;
   * keep 为 null:不截,只是先停下正在生成的那条
   */
  onInterject: (text: string, entryId: string | null, keep: string | null) => void;
  /**
   * 翻回历史、在旧的位置开口:从 entryId 这条回复分出一个新对话(截到 keep 为止)再发。
   * 原来的对话一个字不动,留在存档里
   */
  onBranch: (text: string, entryId: string, keep: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onExit: () => void;
  renderPage: (page: HostPage, ctx: PageContext) => ReactNode;
  /** 标题画面上的角色头像 */
  cards: TitleCard[];
  currentCardId: string | null;
  onPickCard: (id: string, fresh: boolean) => void;
}

interface Beat {
  entry: ChatEntry;
  /** 用户消息为 null */
  parsed: ParsedReply | null;
  /** 展开宏之后、切句之前的原文 —— 插话截断按它算位置 */
  raw: string;
}

interface Cursor {
  id: string;
  swipe: number;
  line: number;
}

interface BgView {
  key: string;
  src: string;
  /** 竖屏时对准横图的哪儿(object-position 的横向百分比) */
  focus: number;
}

interface SpriteView {
  key: string;
  src: string | null;
  /** 没有图时占位长方形上写的字 */
  label: string;
  /** 按脸对齐算出来的位置(plugins/spriteLayout.ts);占位长方形没有 */
  style?: CSSProperties;
}

const reduceMotion =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 逐字显示。key 变了(换了一句)从头打;text 变长(流式还在写)接着打。interval 为 0 整句直接出 */
function useTypewriter(key: string, text: string, interval: number) {
  const instant = reduceMotion || interval <= 0;
  const [state, setState] = useState({ key, n: 0, skipped: instant });
  const current = state.key === key;
  const n = current ? state.n : 0;
  const skipped = current ? state.skipped || instant : instant;

  useEffect(() => {
    if (!current) {
      setState({ key, n: 0, skipped: instant });
      return;
    }
    if (skipped || n >= text.length) return;
    const t = window.setTimeout(
      () => setState((s) => (s.key === key ? { ...s, n: s.n + 1 } : s)),
      interval,
    );
    return () => window.clearTimeout(t);
  }, [key, current, n, skipped, text.length, interval, instant]);

  return {
    shown: skipped ? text : text.slice(0, n),
    done: skipped || n >= text.length,
    skip: () => setState({ key, n: text.length, skipped: true }),
  };
}

/** 每 100ms 走一格的时钟,只在 active 时走 —— 「正在思考 3.2 秒」用 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/**
 * 加载画面的显隐:读得快(<180ms)就不闪一下;一旦露脸至少停 700ms,
 * 免得黑场一闪而过像是出错了
 */
function useLoadingVeil(loading: boolean): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (loading) {
      const t = window.setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, 180);
      return () => window.clearTimeout(t);
    }
    if (!shown) return;
    const t = window.setTimeout(() => setShown(false), Math.max(0, 700 - (Date.now() - since.current)));
    return () => window.clearTimeout(t);
  }, [loading, shown]);
  return shown;
}

/** 立绘层:新图淡入、旧图淡出,切表情时不会闪一下空白背景 */
function SpriteLayer({ view, charName }: { view: SpriteView; charName: string }) {
  const [layers, setLayers] = useState<{ cur: SpriteView; prev: SpriteView | null }>({
    cur: view,
    prev: null,
  });

  useEffect(() => {
    if (view.key !== layers.cur.key) setLayers({ cur: view, prev: layers.cur });
    // 同一张图只是挪了位置(插件页里在调):原地更新,不走淡入淡出
    else if (view !== layers.cur) setLayers((l) => ({ ...l, cur: view }));
  }, [view, layers.cur]);

  // 淡出结束后把旧图摘掉。单独一个 effect:和上面写在一起的话,setLayers 引起的
  // 重跑会先执行清理函数,把这个计时器清掉,旧图就永远留在那儿了
  useEffect(() => {
    if (!layers.prev) return;
    const t = window.setTimeout(() => setLayers((l) => ({ ...l, prev: null })), 320);
    return () => window.clearTimeout(t);
  }, [layers.prev]);

  const render = (v: SpriteView, cls: string) =>
    v.src ? (
      <img
        key={v.key}
        className={`vn-sprite ${cls}`}
        src={v.src}
        alt={`${charName} · ${v.label}`}
        draggable={false}
        style={v.style}
      />
    ) : (
      <div key={v.key} className={`vn-sprite vn-sprite-ph ${cls}`}>
        <span className="vn-sprite-ph-name">{charName || '角色'}</span>
        <span className="vn-sprite-ph-label">{v.label}</span>
      </div>
    );

  return (
    <div className="vn-sprite-stage" aria-hidden="true">
      {layers.prev && render(layers.prev, 'leaving')}
      {render(layers.cur, 'entering')}
    </div>
  );
}

/** 背景层:旧图先淡出、新图稍后淡入,中间透出一点黑,像换场景的转场 */
function BackgroundLayer({ view }: { view: BgView }) {
  const [layers, setLayers] = useState<{ cur: BgView; prev: BgView | null }>({
    cur: view,
    prev: null,
  });

  useEffect(() => {
    if (view.key !== layers.cur.key) setLayers({ cur: view, prev: layers.cur });
    // 同一张图只是改了焦点:原地更新,不走转场
    else if (view.focus !== layers.cur.focus) setLayers((l) => ({ ...l, cur: view }));
  }, [view, layers.cur]);

  // 理由同 SpriteLayer:摘旧图的计时器单独一个 effect
  useEffect(() => {
    if (!layers.prev) return;
    const t = window.setTimeout(() => setLayers((l) => ({ ...l, prev: null })), 900);
    return () => window.clearTimeout(t);
  }, [layers.prev]);

  const render = (v: BgView, cls: string) => (
    <img
      key={v.key}
      className={`vn-bg ${cls}`}
      src={v.src}
      alt=""
      draggable={false}
      style={{ objectPosition: `${v.focus}% 50%` }}
    />
  );

  return (
    <>
      {layers.prev && render(layers.prev, 'leaving')}
      {render(layers.cur, layers.prev ? 'entering' : '')}
    </>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 选项上不要台词外层的引号 */
const unquote = (s: string) => s.replace(/^\s*[「『“"]/, '').replace(/[」』”"]\s*$/, '');

/**
 * 当时玩家发的话弹成选项时的样子:「——」开头的行是写给模型的提示(——场景切换为逛街),
 * 不放进去;整行是一句带引号的台词就去掉引号;空行收掉。剩下是空的就不弹
 */
const playerSaid = (raw: string) =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('——'))
    .map((l) => (/^[「『“”"].*[」』“”"]$/.test(l) ? l.slice(1, -1) : l))
    .join('\n');

export function VNScreen({
  entries,
  macros,
  charName,
  userName,
  sprites,
  spriteStage,
  spriteLayout,
  tagTemplate,
  sceneAssets,
  titleBgmId,
  onChangeTitleBgm,
  bgTemplate,
  bgmTemplate,
  voiceConfig,
  voiceCast,
  onChangeVoiceConfig,
  showJa,
  enterKey,
  onChangeEnterKey,
  sending,
  canSend,
  notReadyHint,
  chatKey,
  chatName,
  chatUpdatedAt,
  cardTag,
  loading,
  modelLabel,
  onSend,
  onInterject,
  onBranch,
  onStop,
  onRegenerate,
  onExit,
  renderPage,
  cards,
  currentCardId,
  onPickCard,
}: Props) {
  // ---- 偏好 ----

  const [settings, setSettings] = useState<VNSettings>(loadVNSettings);
  const changeSettings = (next: VNSettings) => {
    setSettings(next);
    saveVNSettings(next);
  };

  // ---- 解析:每条 AI 回复 → 一句一句 ----

  const tagKinds: TagKind[] = useMemo(
    () => vnTagKinds(tagTemplate, bgTemplate, bgmTemplate),
    [tagTemplate, bgTemplate, bgmTemplate],
  );
  // 流式时每来一个字 entries 就变一次;没变的条目直接用缓存,只重切正在写的那条
  const cacheRef = useRef(new Map<string, { raw: string; cfg: string; parsed: ParsedReply }>());
  const beats: Beat[] = useMemo(() => {
    const cfg = [charName, userName, tagTemplate, bgTemplate, bgmTemplate].join('\u0000');
    const cache = cacheRef.current;
    return entries.map((entry) => {
      if (entry.role === 'user') return { entry, parsed: null, raw: currentText(entry) };
      const raw = substituteMacros(currentText(entry), macros, {
        seed: `${entry.id}:${entry.swipeIndex}`,
      });
      const key = `${entry.id}:${entry.swipeIndex}:${entry.streaming ? 1 : 0}`;
      const hit = cache.get(key);
      if (hit && hit.raw === raw && hit.cfg === cfg) return { entry, parsed: hit.parsed, raw };
      // 外语插件:日中交替写的回复,日语挂到它下面那句中文上;没有日语的和原来一样
      const parsed = parseBilingual(raw, {
        charName,
        userName,
        tags: tagKinds,
        streaming: Boolean(entry.streaming),
      });
      cache.set(key, { raw, cfg, parsed });
      return { entry, parsed, raw };
    });
  }, [entries, macros, charName, userName, tagTemplate, bgTemplate, bgmTemplate, tagKinds]);

  // ---- 播放位置 ----

  const lastAssistantIndex = (() => {
    for (let i = beats.length - 1; i >= 0; i--) if (beats[i].parsed) return i;
    return -1;
  })();

  const startOfLatest = (): Cursor | null => {
    const b = lastAssistantIndex >= 0 ? beats[lastAssistantIndex] : null;
    return b ? { id: b.entry.id, swipe: b.entry.swipeIndex, line: 0 } : null;
  };

  // 进来时停在最新一条回复的第一句 —— 刚在调试台聊到哪,就从那条接着看
  const [cursor, setCursor] = useState<Cursor | null>(startOfLatest);

  // 换了对话(读档 / 新故事):同样从最新一条回复的第一句开始
  const [cursorChat, setCursorChat] = useState(chatKey);
  if (cursorChat !== chatKey) {
    setCursorChat(chatKey);
    setCursor(startOfLatest());
  }

  // 新冒出来的回复(发送 / 继续生成)自动跳过去
  const seenRef = useRef(new Set(entries.map((e) => e.id)));
  useEffect(() => {
    const last = entries[entries.length - 1];
    if (last && last.role === 'assistant' && !seenRef.current.has(last.id)) {
      setCursor({ id: last.id, swipe: last.swipeIndex, line: 0 });
    }
    for (const e of entries) seenRef.current.add(e.id);
  }, [entries]);

  // 光标指向的条目可能被删掉,或者换了分支(重新生成) —— 渲染时就地纠正。
  // 插话截断也会换分支,但同一次提交里新回复已经追加上来,光标直接跳过去了
  let beatIndex = cursor ? beats.findIndex((b) => b.entry.id === cursor.id && b.parsed) : -1;
  let line = cursor?.line ?? 0;
  if (beatIndex === -1) {
    beatIndex = lastAssistantIndex;
    line = Number.MAX_SAFE_INTEGER;
  } else if (beats[beatIndex].entry.swipeIndex !== cursor?.swipe) {
    line = 0;
  }
  const beat = beatIndex >= 0 ? beats[beatIndex] : null;
  const lines = beat?.parsed?.lines ?? [];
  line = Math.max(0, Math.min(line, lines.length - 1));
  const streaming = Boolean(beat?.entry.streaming);
  const current: VNLine | null = lines[line] ?? null;
  // 流式时最后一句还在写,没写完不能往下翻
  const lineComplete = !streaming || line < lines.length - 1;
  const hasNext = line < lines.length - 1;
  const onLatest = beatIndex === lastAssistantIndex && beatIndex >= 0;

  const typeKey = beat ? `${beat.entry.id}:${beat.entry.swipeIndex}:${line}` : 'none';

  // 玩家台词插件:翻到玩家的台词先弹成选项,选中了(记下这句的 typeKey)才打进对话框
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const choosing = Boolean(current?.player) && pickedKey !== typeKey;

  // 翻回历史往下看:一条回复读完,后面是当时玩家发的话 —— 一句句弹成选项(让人看到当时
  // 说了什么),点了接着看下一条回复。最新那条后面没有回复,不弹
  const between = useMemo(() => {
    const said: string[] = [];
    for (let i = beatIndex + 1; beatIndex >= 0 && i < beats.length; i++) {
      const b = beats[i];
      if (b.parsed) return { said, next: b };
      const t = playerSaid(b.raw);
      if (t) said.push(t);
    }
    return { said: [] as string[], next: null as Beat | null };
  }, [beats, beatIndex]);
  // 正在弹第几句;记着是哪一句之后弹的,光标一动就失效
  const [userStep, setUserStep] = useState<{ key: string; i: number } | null>(null);
  const userChoice = userStep?.key === typeKey ? (between.said[userStep.i] ?? null) : null;
  // 这条回复读完了,后面还有下一条(翻回历史的时候)
  const canContinue = !hasNext && !streaming && between.next !== null;
  const continueToNext = () => {
    const nb = between.next;
    if (nb) setCursor({ id: nb.entry.id, swipe: nb.entry.swipeIndex, line: 0 });
    setUserStep(null);
  };

  // ---- 立绘 / 背景 / 音乐:从第一条回复一路累计到当前这句 ----

  // 到当前这句为止已经生效的标签,按出现顺序。当前这条只算到正在播的这句为止;
  // 写在末尾的(-1)要等下一条回复才生效
  const hitsSoFar: TagHit[] = useMemo(() => {
    const out: TagHit[] = [];
    for (let i = 0; i <= beatIndex; i++) {
      const p = beats[i].parsed;
      if (!p) continue;
      for (const h of p.hits) {
        if (i === beatIndex && (h.lineIndex === -1 || h.lineIndex > line)) continue;
        out.push(h);
      }
    }
    return out;
  }, [beats, beatIndex, line]);

  // ---- 立绘标签 → 表情:先精确匹配,对不上的问后端模型 ----

  const candidates = useMemo(() => emotionCandidates(sprites), [sprites]);
  const spriteLabels = useMemo(
    () =>
      beats
        .flatMap((b) => b.parsed?.hits ?? [])
        .filter((h) => h.kind === 'sprite' && !isNpcHit(h, charName))
        .map((h) => h.label),
    [beats, charName],
  );
  const resolveTag = useEmotionMatches(spriteLabels, candidates);
  const emotionCtx: EmotionContext = useMemo(
    () => ({ resolve: resolveTag, rawOnFail: sprites.length === 0, charName }),
    [resolveTag, sprites.length, charName],
  );

  const faces = useMemo(() => facesByCanvas(sprites), [sprites]);
  const spriteView: SpriteView = useMemo(() => {
    // 对不上、还在问模型的标签不切图,保持上一张 —— 控制台里会写原因
    const label = spriteLabelAfter(hitsSoFar, emotionCtx, sprites[0]?.label ?? null);
    const matched = sprites.find((s) => s.label === label) ?? sprites[0] ?? null;
    if (matched) {
      return {
        key: matched.id + (matched.has_image ? `:${matched.image_version}` : ''),
        src: spriteImageUrl(matched),
        label: matched.label,
        style: spriteStyle(faces.get(matched.id) ?? null, spriteLayout, spriteStage),
      };
    }
    // 这张卡一张立绘都没配:占位长方形上写匹配到的内置表情(模型不可用时是 AI 的原词)
    return { key: `ph:${label ?? ''}`, src: null, label: label ?? '未配置立绘' };
  }, [hitsSoFar, sprites, emotionCtx, faces, spriteLayout, spriteStage]);

  const scene: SceneState = useMemo(() => {
    let state = initialScene(sceneAssets);
    for (const h of hitsSoFar) state = applySceneTag(state, h, sceneAssets);
    return state;
  }, [hitsSoFar, sceneAssets]);

  const bgUrl = scene.bg ? sceneFileUrl(scene.bg) : null;
  const bgView: BgView =
    scene.bg && bgUrl
      ? { key: `${scene.bg.id}:${scene.bg.file_version}`, src: bgUrl, focus: scene.bg.focus_x }
      : { key: 'fallback', src: FALLBACK_BACKGROUND, focus: 50 };

  // ---- 标题画面:最后一句、上次停下的地方、场景包里的背景 ----

  // 最新一条回复里她说的最后一句;她没开口就用别人说的最后一句
  const lastLine = useMemo(() => {
    const said = (lastAssistantIndex >= 0 ? beats[lastAssistantIndex].parsed?.lines : null) ?? [];
    const pick = (ok: (l: VNLine) => boolean) => {
      for (let i = said.length - 1; i >= 0; i--) if (!said[i].player && said[i].text.trim() && ok(said[i])) return said[i];
      return null;
    };
    const l = pick((x) => x.speaker === charName) ?? pick((x) => Boolean(x.speaker));
    return l ? unquote(l.text.trim()) : null;
  }, [beats, lastAssistantIndex, charName]);
  const titleHome: TitleScene = { key: bgView.key, src: bgView.src, focus: bgView.focus, label: scene.bg?.label ?? '' };
  const titleScenes: TitleScene[] = useMemo(
    () =>
      backgroundsOf(sceneAssets).flatMap((a) => {
        const src = sceneFileUrl(a);
        return src ? [{ key: `${a.id}:${a.file_version}`, src, focus: a.focus_x, label: a.label }] : [];
      }),
    [sceneAssets],
  );

  // ---- 音乐 ----

  // 标题画面开着时放封面音乐(场景包里设的那首,没设就是排第一的),「继续」后换回场景的
  const [title, setTitle] = useState(settings.titleScreen);
  const titleBgm = useMemo(() => titleBgmOf(sceneAssets, titleBgmId), [sceneAssets, titleBgmId]);
  const playing = title ? titleBgm : scene.bgm;
  const bgmUrl = playing ? sceneFileUrl(playing) : null;
  useEffect(() => {
    bgmPlayer.setActive(true);
    return () => bgmPlayer.setActive(false);
  }, []);
  useEffect(() => {
    bgmPlayer.play(bgmUrl);
  }, [bgmUrl]);

  // 当前这条回复里点到的背景和曲子提前下载:翻到那一句时直接切,不用等
  const upcoming = beat?.parsed?.hits;
  useEffect(() => {
    for (const h of upcoming ?? []) {
      if (h.kind === 'bg') {
        const bg = resolveByLabel(h.label, backgroundsOf(sceneAssets));
        const url = bg && sceneFileUrl(bg);
        if (url) new Image().src = url;
        const def = bg?.bgm_id ? sceneAssets.find((a) => a.id === bg.bgm_id) : null;
        const defUrl = def && sceneFileUrl(def);
        if (defUrl) bgmPlayer.prefetch(defUrl);
      } else if (h.kind === 'bgm') {
        const m = resolveByLabel(h.label, bgmsOf(sceneAssets));
        const url = m && sceneFileUrl(m);
        if (url) bgmPlayer.prefetch(url);
      }
    }
  }, [upcoming, sceneAssets]);

  // 立绘预加载:切表情时直接从缓存出图,不用等下载
  useEffect(() => {
    for (const s of sprites) {
      const url = spriteImageUrl(s);
      if (url) new Image().src = url;
    }
  }, [sprites]);

  // ---- 界面状态 ----

  const [menu, setMenu] = useState<MenuPage | null>(null);
  // 菜单上次停在哪一页,Esc 再打开时回到那儿
  const [lastPage, setLastPage] = useState<MenuPage>('log');
  const [rawLog, setRawLog] = useState(false);
  // 历史页:鼠标移上去(手机上点一下)的那句露出「回到这里」「语音详情」;展开了详情的那句
  const [pickedLine, setPickedLine] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [pluginFocus, setPluginFocus] = useState<PluginFocus | null>(null);
  const [uiHidden, setUiHidden] = useState(false);
  const [draft, setDraft] = useState('');
  const [auto, setAuto] = useState(false);
  const [skip, setSkip] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const skipping = skip || ctrlHeld;
  const veil = useLoadingVeil(loading);
  const accent = useVNAccent(settings.accent, sprites);

  // ---- 语音:说话人对得上声音的台词才念,情绪跟着这句生效的立绘表情 ----

  // 这条回复第一句之前生效的表情(和立绘层同一套累计算法)
  const emotionBefore = useMemo(() => {
    const prior: TagHit[] = [];
    for (let i = 0; i < beatIndex; i++) prior.push(...(beats[i].parsed?.hits ?? []));
    return spriteLabelAfter(prior, emotionCtx, sprites[0]?.label ?? null);
  }, [beats, beatIndex, sprites, emotionCtx]);
  // 切好的句子是按条目缓存的,流式时只有正在写的那条会变
  const beatParsed = beat?.parsed;
  const voicePlans = useMemo(
    () =>
      planVoiceLines({
        lines: beatParsed?.lines ?? [],
        hits: beatParsed?.hits ?? [],
        emotionBefore,
        ctx: emotionCtx,
        cast: voiceCast,
        streaming,
        fixedEmotion: voiceConfig.fixedEmotion,
      }),
    [beatParsed, emotionBefore, emotionCtx, voiceCast, streaming, voiceConfig.fixedEmotion],
  );
  const voice = useVoiceLine({
    config: voiceConfig,
    plans: voicePlans,
    line,
    lineKey: typeKey,
    silent: skipping || title,
    warmupId: voiceCast.main?.id ?? null,
    probeConnectionId: voiceCast.main?.connection_id ?? null,
    interrupt: settings.voiceInterrupt,
  });

  // 念台词时 BGM 压到多少,跟着设置走
  useEffect(() => {
    bgmPlayer.setDuckLevel(settings.duckLevel);
  }, [settings.duckLevel]);

  // 等语音时先不打字:好了文字和声音一起出。玩家台词还没选的时候也不打
  const typer = useTypewriter(
    typeKey,
    voice.gated || choosing ? '' : (current?.text ?? ''),
    settings.textSpeed,
  );
  const typedDone = typer.done && !voice.gated && !choosing;

  // ---- 历史页:每条回复按画面上的句子列出来,要念的句子带重播 / 重新生成 ----

  const logOpen = menu === 'log';
  const backlog = useMemo(() => {
    const out = new Map<
      string,
      {
        lines: VNLine[];
        plans: (SpeakRequest | null)[];
        hits: TagHit[];
        /** 这条回复第一句之前生效的表情 —— 语音详情要看 */
        before: string | null;
        streaming: boolean;
      }
    >();
    if (!logOpen) return out;
    // 和 emotionBefore 同一套累计:每条回复开头的表情 = 之前所有立绘标签依次生效的结果
    let label: string | null = sprites[0]?.label ?? null;
    for (const b of beats) {
      const p = b.parsed;
      if (!p) continue;
      const streaming = Boolean(b.entry.streaming);
      const plans = voiceConfig.enabled
        ? planVoiceLines({
            lines: p.lines,
            hits: p.hits,
            emotionBefore: label,
            ctx: emotionCtx,
            cast: voiceCast,
            streaming,
            fixedEmotion: voiceConfig.fixedEmotion,
          })
        : [];
      out.set(b.entry.id, { lines: p.lines, plans, hits: p.hits, before: label, streaming });
      label = spriteLabelAfter(p.hits, emotionCtx, label);
    }
    return out;
  }, [logOpen, beats, sprites, emotionCtx, voiceCast, voiceConfig.enabled, voiceConfig.fixedEmotion]);

  const lineView = (entry: ChatEntry): ReactNode | null => {
    const b = backlog.get(entry.id);
    if (!b || b.lines.length === 0) return null;
    const here = beat?.entry.id === entry.id;
    return (
      <div className="vn-log-lines">
        {b.lines.map((ln, i) => {
          const plan = b.plans[i] ?? null;
          const key = `${entry.id}:${i}`;
          const open = detailKey === key;
          const picked = pickedLine === key;
          // 鼠标移上去露出操作;没有悬停的手机上点一下这句露出来,再点收起
          const pick = () => setPickedLine(picked ? null : key);
          return (
            <Fragment key={i}>
              <div
                className={`vn-log-line${ln.speaker ? '' : ' narration'}${ln.player ? ' player' : ''}${here && i === line ? ' current' : ''}${picked ? ' picked' : ''}${open ? ' open' : ''}`}
                tabIndex={0}
                onClick={pick}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                  e.preventDefault();
                  pick();
                }}
              >
                <span className="vn-log-text">
                  {showJa && ln.ja && <span className="vn-log-ja">{ln.ja}</span>}
                  {ln.speaker && <span className="vn-log-speaker">{ln.speaker}</span>}
                  {ln.text}
                </span>
                {plan && <VoiceButtons req={plan} />}
                {/* 操作浮在这句右上角,不挤正文 */}
                <span className="vn-log-acts" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => jumpTo(entry.id, i)} title="从这一句接着看(重玩)">
                    回到这里
                  </button>
                  <button
                    type="button"
                    className={open ? 'on' : ''}
                    aria-expanded={open}
                    onClick={() => setDetailKey(open ? null : key)}
                    title="这句的情绪、参考音频、发给语音服务的请求 —— 排查语音用"
                  >
                    语音详情
                  </button>
                </span>
              </div>
              {open && (
                <VoiceDetail
                  line={ln}
                  index={i}
                  hits={b.hits}
                  emotionBefore={b.before}
                  plan={plan}
                  profile={ln.player ? null : voiceForSpeaker(ln.speaker, charName, voiceCast)}
                  ctx={emotionCtx}
                  voiceEnabled={voiceConfig.enabled}
                  fixedEmotion={voiceConfig.fixedEmotion}
                  streamingLast={b.streaming && i === b.lines.length - 1}
                  onJump={() => jumpTo(entry.id, i)}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    );
  };

  const openMenu = (page?: MenuPage) => {
    const p = page ?? lastPage;
    setMenu(p);
    setLastPage(p);
    setAuto(false);
    setSkip(false);
  };
  const closeMenu = () => setMenu(null);
  const openPlugin = (section: PluginSection) => {
    setPluginFocus({ section, nonce: Date.now() });
    setMenu('plugin');
    setLastPage('plugin');
  };

  const advance = () => {
    if (uiHidden) {
      setUiHidden(false);
      return;
    }
    if (!beat || !current) return;
    // 当时玩家发的话:点哪里都算选中,接着弹下一句,或者去下一条回复
    if (userChoice !== null && userStep) {
      if (userStep.i + 1 < between.said.length) setUserStep({ key: typeKey, i: userStep.i + 1 });
      else continueToNext();
      return;
    }
    // 选项:点哪里都算选中;流式时这句还没写完不能选
    if (choosing) {
      if (lineComplete) setPickedKey(typeKey);
      return;
    }
    if (voice.gated) {
      voice.release();
      return;
    }
    if (!typer.done) {
      typer.skip();
      return;
    }
    if (hasNext && lineComplete) {
      setCursor({ id: beat.entry.id, swipe: beat.entry.swipeIndex, line: line + 1 });
    } else if (canContinue) {
      if (between.said.length > 0) setUserStep({ key: typeKey, i: 0 });
      else continueToNext();
    }
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const busyOverlay = title || menu !== null;

  // 自动播放:一句打完停一会儿翻下一句;流式时等下一句写完再翻。
  // 设置里开着「等语音」时,这句的语音还在合成或正在念就先不翻(合成失败了照常翻)。
  // 玩家台词的选项:这句写完了就停一会儿自动选掉。
  // 翻回历史时一条回复读完接着往下:当时玩家发的话也一样停一会儿选掉
  const voiceHolds = settings.autoWaitVoice && (voice.speaking || voice.synthesizing);
  useEffect(() => {
    if (!auto || busyOverlay || uiHidden || skipping || !current || !lineComplete) return;
    const ready =
      userChoice !== null || choosing || (typedDone && !voiceHolds && (hasNext || canContinue));
    if (!ready) return;
    const t = window.setTimeout(() => advanceRef.current(), settings.autoDelay);
    return () => window.clearTimeout(t);
  }, [auto, busyOverlay, uiHidden, skipping, current, userChoice, userStep, choosing, typedDone, voiceHolds, hasNext, canContinue, lineComplete, settings.autoDelay, typeKey]);

  // 跳过:连打带翻(选项直接选掉),翻到最新那条回复的最后一句自己停 —— 翻回历史时读过的
  // 一路跳过去。依赖里要有 choosing:选完这句文字从头打,typedDone 没变,不重跑就停在这儿了
  useEffect(() => {
    if (!skipping || busyOverlay || !current) return;
    if (choosing && !lineComplete) return;
    const more = (hasNext && lineComplete) || canContinue || userChoice !== null;
    if (typedDone && !more) {
      if (!streaming && skip) setSkip(false);
      return;
    }
    const t = window.setTimeout(() => advanceRef.current(), 60);
    return () => window.clearTimeout(t);
  }, [skipping, skip, busyOverlay, current, choosing, userChoice, userStep, canContinue, typedDone, hasNext, lineComplete, streaming, typeKey]);

  useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        if (!busyOverlay) setCtrlHeld(true);
        return;
      }
      if (e.key === 'Escape') {
        if (title) return;
        if (menu) setMenu(null);
        else if (uiHidden) setUiHidden(false);
        else if (!isField(e.target)) {
          setMenu(lastPage);
          setAuto(false);
          setSkip(false);
        }
        return;
      }
      if (isField(e.target) || busyOverlay) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        bgmPlayer.unlock();
        advanceRef.current();
      } else if (e.key === 'a' || e.key === 'A') {
        setAuto((a) => !a);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setCtrlHeld(false);
    };
    const onBlur = () => setCtrlHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [busyOverlay, title, menu, uiHidden, lastPage]);

  // 滚轮往上 = 看历史;右键 = 隐藏界面(galgame 玩家的习惯)
  const onWheel = (e: React.WheelEvent) => {
    if (busyOverlay || e.deltaY > -8) return;
    openMenu('log');
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setUiHidden((h) => !h);
  };

  // ---- 输入:一直在,随时插话 ----

  const send = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft('');
    bgmPlayer.unlock();
    setAuto(false);
    setSkip(false);
    const latest = lastAssistantIndex >= 0 ? beats[lastAssistantIndex] : null;
    const last = entries[entries.length - 1];
    // 一条回复只留到玩家看到的这句为止的原文。尽量在库里的原文上截,{{char}} 这类宏原样
    // 留着;宏展开前后切出来的句数对不上(极少见,长段落按字数硬切时)才退回到展开后的文本上截
    const keepUpTo = (b: Beat, parsed: ParsedReply) => {
      if (lines.length === 0) return '';
      const stored = currentText(b.entry);
      const plain = parseBilingual(stored, {
        charName,
        userName,
        tags: tagKinds,
        streaming: Boolean(b.entry.streaming),
      });
      return plain.lines.length === parsed.lines.length
        ? stored.slice(0, plain.ends[line]).trimEnd()
        : b.raw.slice(0, parsed.ends[line]).trimEnd();
    };
    if (!onLatest && beat?.parsed && lines.length > 0) {
      // 翻回历史、在旧的位置开口:从这里分出一条新的故事线,原来的对话留在存档里
      onBranch(text, beat.entry.id, keepUpTo(beat, beat.parsed));
    } else if (onLatest && latest?.parsed && (streaming || hasNext)) {
      // 最新这条还没读完就开口了:这条回复只留到玩家看到的这句为止
      onInterject(text, latest.entry.id, keepUpTo(latest, latest.parsed));
    } else if (sending) {
      // 在往回翻旧的时候插话:不截断,只是先停下正在写的那条
      onInterject(text, last?.role === 'assistant' ? last.id : null, null);
    } else {
      onSend(text);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };

  // 回车发送还是换行看设置;自动模式下手机软键盘没有 Shift,回车就是换行,点按钮发送
  const softKeyboard = useCoarsePointer();
  // 窄屏时占位符放不下这串按键提示(会折成两行被截掉),干脆不提
  const narrow = useIsMobile();
  const hint = softKeyboard || narrow ? '' : enterHint(enterKey, softKeyboard);
  const enterSends = enterKey === 'send' || (enterKey === 'auto' && !softKeyboard);

  // 输入框跟着内容长高,封顶四行左右,再多就在框里滚
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 132)}px`;
  }, [draft]);

  /**
   * 跳到某条回复的某一句,关掉菜单。立绘、背景、音乐都是按光标累计的,跟着回到那一句的样子;
   * 选过的玩家台词也忘掉,重玩时再弹一次选项
   */
  const jumpTo = (entryId: string, at = 0) => {
    const b = beats.find((x) => x.entry.id === entryId && x.parsed);
    if (b) setCursor({ id: b.entry.id, swipe: b.entry.swipeIndex, line: at });
    setPickedKey(null);
    setUserStep(null);
    setMenu(null);
  };

  // ---- 思考中 / 生成中 ----

  const info = beat ? currentInfo(beat.entry) : undefined;
  const reasoning = info?.reasoning ?? '';
  const waiting = streaming && lines.length === 0;
  const now = useNow(waiting);
  const thinkKey = beat ? `${beat.entry.id}:${beat.entry.swipeIndex}` : '';
  // 计时:思考开始之前从发出去算(「正在组织语言」),思考开始后从第一段思考算 ——
  // 和生成完显示的「已思考 N 秒」是同一个起点,两个数才对得上
  const [reasonStart, setReasonStart] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (waiting && reasoning && reasonStart?.key !== thinkKey) {
      setReasonStart({ key: thinkKey, at: Date.now() });
    }
  }, [waiting, reasoning, thinkKey, reasonStart]);
  const sentAt = info?.sendDate ? Date.parse(info.sendDate) : NaN;
  const since = reasoning && reasonStart?.key === thinkKey ? reasonStart.at : sentAt;
  const elapsed = Number.isFinite(since) ? Math.max(0, now - since) : 0;
  const [thinkOpenKey, setThinkOpenKey] = useState<string | null>(null);
  const thinkOpen = thinkOpenKey === thinkKey && settings.showThinking;
  // 回复出来以后,第一句上留一个「已思考 N 秒」的小条,点开还能看
  const showThinkChip = !waiting && line === 0 && Boolean(reasoning) && settings.showThinking;

  // ---- 渲染 ----

  // 选项弹着的时候,对话框里留着上一句(整句,不打字);这条回复第一句就是玩家台词时留空
  const shown: VNLine | null = choosing ? (lines[line - 1] ?? null) : current;
  let speaker: string | null = shown?.speaker ?? null;
  let body: ReactNode;
  if (waiting) {
    speaker = charName;
    body = null;
  } else if (choosing) {
    body = shown ? shown.text : null;
  } else if (current) {
    body = (
      <>
        {typer.shown}
        {voice.gated && (
          <span className="vn-voice-wait" title="等语音…(点一下先出文字)">
            ……
          </span>
        )}
        {/* 不等语音:文字照常出,语音还在合成就在字后面转个圈,好了自己念、圈消失 */}
        {!voice.gated && voice.synthesizing && (
          <span className="vn-voice-spin" role="status" aria-label="正在生成语音" title="正在生成语音" />
        )}
        {streaming && !hasNext && typedDone && <span className="vn-caret" />}
      </>
    );
  } else {
    body = (
      <span className="vn-empty">
        {canSend ? '还没有对话。在下面说点什么,开始吧。' : notReadyHint}
      </span>
    );
  }
  const showNextMark =
    Boolean(current) && typedDone && userChoice === null && ((hasNext && lineComplete) || canContinue);
  const atEnd = Boolean(current) && typedDone && !hasNext && !streaming && !canContinue;
  const lastEntry = entries[entries.length - 1];
  const currentMessageId = onLatest ? (lastEntry?.id ?? null) : (beat?.entry.id ?? null);

  const hostPage = (page: HostPage) =>
    renderPage(page, {
      close: closeMenu,
      jumpTo,
      currentMessageId,
      raw: rawLog,
      lineView,
      openPlugin,
      pluginFocus,
    });

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className={`vn-root${uiHidden ? ' ui-hidden' : ''}${menu ? ' menu-open' : ''}`}
      data-skin="classic"
      style={
        {
          '--vn-box-alpha': settings.boxOpacity,
          '--vn-text-scale': settings.textScale,
          '--vn-accent': accent.accent,
          '--vn-accent-ink': accent.ink,
          '--vn-accent-rgb': accent.rgb,
        } as React.CSSProperties
      }
      // 浏览器要用户点过才让网页出声;界面里任何一次点击都顺手解锁一下
      onPointerDown={() => bgmPlayer.unlock()}
    >
      <div className="vn-stage" onClick={advance} onWheel={onWheel} onContextMenu={onContextMenu}>
        <BackgroundLayer view={bgView} />
        <SpriteLayer view={spriteView} charName={charName} />
      </div>

      {/* 翻回历史往下看:当时玩家发的话弹成选项,点哪里都接着往下 */}
      {userChoice !== null && (
        <div className="vn-choice-layer">
          <button className="vn-choice past" onClick={advance}>
            <span className="vn-choice-cap">当时的回复</span>
            <span className="vn-choice-text">{userChoice}</span>
          </button>
        </div>
      )}

      {/* 玩家台词插件:翻到玩家的台词先弹成选项,点哪里都算选中 */}
      {choosing && current && (
        <div className="vn-choice-layer">
          <button className="vn-choice" onClick={advance} disabled={!lineComplete}>
            {showJa && current.ja && <span className="vn-choice-ja">{unquote(current.ja)}</span>}
            <span className="vn-choice-text">{unquote(current.text)}</span>
          </button>
        </div>
      )}

      {((settings.showModel && modelLabel) || voice.paused) && (
        <div className="vn-topbar">
          {voice.paused && (
            <button className="vn-chip warn" onClick={voice.retry} title={voice.lastError ?? ''}>
              语音断了 · 每 15 秒自动重连,点这里马上试
            </button>
          )}
          {settings.showModel && modelLabel && (
            <span className="vn-chip" title="当前模型 —— 菜单「模型」里换">
              {modelLabel}
            </span>
          )}
        </div>
      )}

      <div className="vn-window" onWheel={onWheel}>
        <div className="vn-box" onClick={advance} onContextMenu={onContextMenu}>
          {speaker && <div className={`vn-name${shown?.player ? ' player' : ''}`}>{speaker}</div>}
          {sending && (
            <span className="vn-gen" title="正在生成">
              <Feather size={14} className="breathe" />
              生成中
            </span>
          )}

          {(waiting || showThinkChip) && (
            <div className={`vn-think${waiting ? ' live' : ''}${thinkOpen ? ' open' : ''}`} onClick={stop}>
              <button
                className="vn-think-head"
                onClick={() => setThinkOpenKey(thinkOpen ? null : thinkKey)}
                disabled={!reasoning || !settings.showThinking}
                aria-expanded={thinkOpen}
              >
                <Feather size={16} className={waiting ? 'breathe' : ''} />
                <span className="vn-think-label">
                  {waiting
                    ? reasoning
                      ? '正在思考'
                      : '正在组织语言…'
                    : info?.reasoningMs
                      ? `已思考 ${seconds(info.reasoningMs)}`
                      : '思考过程'}
                </span>
                {waiting && <span className="vn-think-secs">{seconds(elapsed)}</span>}
                {waiting && reasoning && !thinkOpen && settings.showThinking && (
                  <span className="vn-think-peek">…{reasoning.slice(-24)}</span>
                )}
                {reasoning && settings.showThinking && (
                  <span className="vn-think-more">{thinkOpen ? '收起' : '展开'}</span>
                )}
              </button>
              {thinkOpen && <div className="vn-think-body">{reasoning}</div>}
            </div>
          )}

          {/* 外语插件:这句的日语小字在上,中文照常打字在下 */}
          {showJa && shown?.ja && !waiting && <div className="vn-ja">{shown.ja}</div>}
          {body !== null && <div className={`vn-text${speaker ? '' : ' narration'}`}>{body}</div>}
          {showNextMark && <span className="vn-next" aria-hidden="true">▼</span>}
          {atEnd && <span className="vn-end" aria-hidden="true">■</span>}

          <div className="vn-quick" onClick={stop}>
            {voice.request && <VoiceButtons req={voice.request} onAction={voice.release} className="lead" />}
            <button onClick={() => openMenu('log')}>历史</button>
            <button className="wide-only" onClick={() => openMenu('save')}>存档</button>
            <button className={auto ? 'on' : ''} onClick={() => setAuto((a) => !a)} aria-pressed={auto}>
              自动
            </button>
            <button className={`wide-only${skip ? ' on' : ''}`} onClick={() => setSkip((s) => !s)} aria-pressed={skip}>
              跳过
            </button>
            <button
              className="wide-only"
              onClick={onRegenerate}
              disabled={sending || entries.length === 0 || !canSend}
              title="重新生成最后一条回复"
            >
              重来
            </button>
            <button className="wide-only" onClick={() => setUiHidden(true)} title="隐藏界面,只看立绘和背景(右键也行)">
              隐藏
            </button>
            <button className="wide-only" onClick={() => openMenu('config')}>设置</button>
            <button onClick={() => openMenu()}>菜单</button>
          </div>
        </div>
        <form className="vn-input" onSubmit={submit}>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              canSend
                ? !onLatest && beat
                  ? '在这里开口,会从这里分出一条新的故事线…'
                  : sending
                    ? '随时插话…'
                    : `以 ${userName} 的身份说点什么…${hint ? `(${hint})` : ''}`
                : notReadyHint
            }
            disabled={!canSend}
            // 软键盘右下角那颗键显示成「发送」还是「换行」
            enterKeyHint={enterSends ? 'send' : 'enter'}
            onKeyDown={(e) => {
              // 输入法选字时的回车是确认候选词,enterShouldSend 里已经挡掉
              if (enterShouldSend(e, enterKey, softKeyboard)) {
                e.preventDefault();
                send();
              }
            }}
          />
          {sending && !draft.trim() ? (
            <button type="button" className="vn-send stop" onClick={onStop}>
              停止
            </button>
          ) : (
            <button type="submit" className="vn-send" disabled={!canSend || !draft.trim()}>
              发送
            </button>
          )}
        </form>
      </div>

      {menu && (
        <VNMenu
          page={menu}
          onPage={(p) => {
            setMenu(p);
            setLastPage(p);
            // 从导航点进插件页:停在默认的第一个插件,不再跳回上次指定的那个
            setPluginFocus(null);
          }}
          charName={charName}
          chatName={chatName}
          headExtra={
            menu === 'log' ? (
              <label className="vn-switch">
                <input type="checkbox" checked={rawLog} onChange={(e) => setRawLog(e.target.checked)} />
                显示原文
                <span className="vn-page-note">标签、宏原样露出来</span>
              </label>
            ) : null
          }
          onClose={closeMenu}
          onTitle={() => {
            setMenu(null);
            setTitle(true);
          }}
        >
          {menu === 'config' ? (
            <VNSettingsPage
              settings={settings}
              onChange={changeSettings}
              enterKey={enterKey}
              onChangeEnterKey={onChangeEnterKey}
              voiceConfig={voiceConfig}
              onChangeVoiceConfig={onChangeVoiceConfig}
              voiceCastName={
                currentCardId ? (voiceCast.main?.name ?? voiceCast.extras[0]?.name ?? null) : undefined
              }
              onOpenVoice={() => openPlugin('voice')}
              titleMusic={
                currentCardId
                  ? { bgms: bgmsOf(sceneAssets), value: titleBgmId, onChange: onChangeTitleBgm }
                  : null
              }
            />
          ) : menu === 'dev' ? (
            <div className="vn-dev">
              <div className="vn-page-bar">
                <span className="vn-page-note">当前这条回复的原文和标签;提示词检查器在完整调试台里</span>
                <div className="vn-page-actions">
                  <button className="vn-pill accent" onClick={onExit}>
                    回到调试台
                  </button>
                </div>
              </div>
              <ConsoleView
                beat={beat}
                beatNumber={beats.slice(0, beatIndex + 1).filter((b) => b.parsed).length}
                sprites={sprites}
                emotion={emotionCtx}
                tagKinds={tagKinds}
                sceneAssets={sceneAssets}
                scene={scene}
                voice={{
                  enabled: voiceConfig.enabled,
                  fixedEmotion: voiceConfig.fixedEmotion,
                  cast: voiceCast,
                  plans: voicePlans,
                  clips: voice.clips,
                  paused: voice.paused,
                  lastError: voice.lastError,
                  charName,
                  streaming,
                }}
              />
            </div>
          ) : (
            hostPage(menu)
          )}
        </VNMenu>
      )}

      {title && (
        <VNTitle
          variant={settings.titleStyle}
          cardId={currentCardId}
          charName={charName}
          tag={cardTag}
          lastPlayed={chatUpdatedAt}
          lastLine={lastLine}
          sprites={sprites}
          faces={faces}
          spriteStage={spriteStage}
          spriteLayout={spriteLayout}
          home={titleHome}
          scenes={titleScenes}
          cards={cards}
          onContinue={() => setTitle(false)}
          onNewStory={() => {
            if (!currentCardId) return;
            setTitle(false);
            onPickCard(currentCardId, true);
          }}
          onSwitchCard={(id) => onPickCard(id, false)}
          onLoad={() => {
            setTitle(false);
            openMenu('save');
          }}
          onSettings={() => {
            setTitle(false);
            openMenu('config');
          }}
          onExit={onExit}
        />
      )}

      {/* 标题画面开着时不盖黑场:在封面上点头像换人,由封面自己的转场遮 */}
      {veil && !title && (
        <div className="vn-loading" aria-live="polite">
          <span className="vn-loading-hint">正在准备 · 背景 · 立绘 · 对话</span>
          <span className="vn-loading-mark">
            <Feather size={28} className="drift" />
            NOW LOADING
          </span>
        </div>
      )}
    </div>
  );
}

const KIND_NAME: Record<string, string> = { sprite: '立绘', bg: '场景', bgm: '音乐', player: '玩家' };

const BGM_FROM: Record<NonNullable<SceneState['bgmFrom']>, string> = {
  initial: '开场默认',
  scene: '场景默认曲',
  tag: 'AI 标签',
};

/** 控制台里一个立绘标签的匹配结果 */
function describeMatch(m: TagMatch, sprites: readonly CardSprite[]): { ok: boolean; text: string } {
  const noImage = (label: string) => {
    const s = sprites.find((x) => x.label === label);
    return s && !s.has_image ? '(还没传图)' : '';
  };
  const where = sprites.length === 0 ? '内置表情 ' : '';
  switch (m.state) {
    case 'exact':
      return { ok: true, text: `✓ ${where}${m.label}${noImage(m.label)}` };
    case 'model':
      return { ok: true, text: `≈ ${where}${m.label}(模型 ${m.score.toFixed(2)})${noImage(m.label)}` };
    case 'pending':
      return { ok: true, text: '… 识别中' };
    case 'failed':
      return {
        ok: false,
        text: `✗ ${m.reason},${sprites.length === 0 ? '占位框写原词' : '保持上一张'}`,
      };
  }
}

/** 开发者页:模型这条回复的完整原文,以及每个标签落在哪一句、对上了哪个素材 */
function ConsoleView({
  beat,
  beatNumber,
  sprites,
  emotion,
  tagKinds,
  sceneAssets,
  scene,
  voice,
}: {
  beat: Beat | null;
  beatNumber: number;
  sprites: CardSprite[];
  /** 立绘标签的匹配(精确 / 模型) */
  emotion: EmotionContext;
  tagKinds: TagKind[];
  sceneAssets: SceneAsset[];
  scene: SceneState;
  voice: {
    enabled: boolean;
    /** 情绪不变:不等模型认表情 */
    fixedEmotion: boolean;
    cast: VoiceCast;
    plans: readonly (SpeakRequest | null)[];
    clips: ReadonlyMap<string, ClipState>;
    paused: boolean;
    lastError: string | null;
    charName: string;
    streaming: boolean;
  };
}) {
  const raw = beat?.raw ?? '';
  const hits = beat?.parsed?.hits ?? [];
  const lines = beat?.parsed?.lines ?? [];

  /** 标签 → 匹配结果 */
  const resolve = useMemo(
    () =>
      (kind: string, label: string): { ok: boolean; text: string } => {
        if (kind === 'sprite') return describeMatch(emotion.resolve(label), sprites);
        if (kind === 'player') return { ok: true, text: '✓ 玩家台词,弹选项,不念' };
        const pool = kind === 'bg' ? backgroundsOf(sceneAssets) : bgmsOf(sceneAssets);
        const a = resolveByLabel(label, pool);
        if (a) return { ok: true, text: `✓ ${a.label}${a.has_file ? '' : '(还没传文件)'}` };
        if (sceneAssets.length === 0) return { ok: false, text: '✗ 这张卡没有绑定场景包' };
        return { ok: false, text: `✗ 场景包里没有这个${KIND_NAME[kind]},保持不变` };
      },
    [sprites, sceneAssets, emotion],
  );

  // 原文里把几类标签都高亮出来
  const highlighted = useMemo(() => {
    if (!raw) return [raw];
    const found: { at: number; text: string; ok: boolean; kind: string }[] = [];
    for (const k of tagKinds) {
      if (!k.pattern) continue;
      for (const m of raw.matchAll(new RegExp(k.pattern.source, 'g'))) {
        found.push({ at: m.index ?? 0, text: m[0], ok: resolve(k.kind, m[1]).ok, kind: k.kind });
      }
    }
    found.sort((a, b) => a.at - b.at);
    const out: ReactNode[] = [];
    let last = 0;
    for (const f of found) {
      if (f.at < last) continue;
      out.push(raw.slice(last, f.at));
      out.push(
        <mark key={f.at} className={`${f.ok ? 'ok' : 'miss'} k-${f.kind}`}>
          {f.text}
        </mark>,
      );
      last = f.at + f.text.length;
    }
    out.push(raw.slice(last));
    return out;
  }, [raw, tagKinds, resolve]);

  const broken = tagKinds.filter((k) => !k.pattern).map((k) => KIND_NAME[k.kind]);

  return (
    <div className="vn-console">
      <div className="vn-console-section">
        <div className="vn-console-title">
          此刻
          <span className="vn-console-sub">
            {beat
              ? `第 ${beatNumber} 条回复 · 分支 ${beat.entry.swipeIndex + 1}/${beat.entry.swipes.length} · ${lines.length} 句`
              : '还没有回复'}
          </span>
        </div>
        <p className="vn-console-note now">
          场景:{scene.bg ? `「${scene.bg.label}」` : '默认背景(这张卡没绑场景包,或者包里没有背景)'}
          {' · '}
          音乐:{scene.bgm ? `「${scene.bgm.label}」(${BGM_FROM[scene.bgmFrom ?? 'tag']})` : '无'}
        </p>
      </div>
      <div className="vn-console-section">
        <div className="vn-console-title">
          标签
          {broken.length > 0 && (
            <span className="vn-console-warn">{broken.join('、')}的模板不合法,这几类不识别</span>
          )}
        </div>
        {hits.length === 0 ? (
          <p className="vn-console-note">
            这条回复里没有标签。去插件面板检查:当前预设里有没有「立绘指令 / 场景指令 / 音乐指令 · 插件」这几个块,块有没有开启。
          </p>
        ) : (
          <div className="vn-console-scroll">
            <table className="vn-console-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>类别</th>
                  <th>标签原文</th>
                  <th>生效于</th>
                  <th>匹配结果</th>
                </tr>
              </thead>
              <tbody>
                {hits.map((h, i) => {
                  const r =
                    h.kind === 'sprite' && isNpcHit(h, emotion.charName)
                      ? { ok: true, text: `— 「${h.speaker}」的台词,不切立绘` }
                      : resolve(h.kind, h.label);
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{KIND_NAME[h.kind] ?? h.kind}</td>
                      <td>
                        <code>{h.raw}</code>
                      </td>
                      <td>{h.lineIndex === -1 ? '回复末尾(延续到下一条)' : `第 ${h.lineIndex + 1} 句`}</td>
                      <td className={r.ok ? 'ok' : 'miss'}>{r.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="vn-console-section">
        <div className="vn-console-title">
          语音
          <span className="vn-console-sub">
            {!voice.enabled
              ? '插件里关着'
              : !voice.cast.main && voice.cast.extras.length === 0
                ? '这张卡没绑声音(调试台 → 插件 → 语音)'
                : voice.paused
                  ? `连续失败,暂停中(每 15 秒自动重连):${voice.lastError ?? ''}`
                  : `主声音「${voice.cast.main?.name ?? '无'}」${voice.fixedEmotion ? ' · 情绪不变' : ''}`}
          </span>
        </div>
        {lines.length > 0 && (
          <div className="vn-console-scroll">
            <table className="vn-console-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>说话人 → 声音</th>
                  <th>情绪(要的 → 实际)</th>
                  <th>方式</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((ln, i) => {
                  const plan = voice.plans[i] ?? null;
                  const profile = ln.player ? null : voiceForSpeaker(ln.speaker, voice.charName, voice.cast);
                  const st = plan ? voice.clips.get(voiceKey(plan)) : undefined;
                  const why = voiceSkipReason(ln, profile, {
                    streamingLast: voice.streaming && i === lines.length - 1,
                    pendingTag:
                      !voice.fixedEmotion &&
                      spriteHitsUpTo(hits, i, voice.charName).some(
                        (h) => emotion.resolve(h.label).state === 'pending',
                      ),
                  });
                  const actual =
                    st?.state === 'ready' && st.emotion !== (plan?.emotion ?? '') ? ` → ${st.emotion}` : '';
                  return (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>
                        {ln.untagged ? '(没写立绘标签)' : (ln.speaker ?? '旁白')}
                        {profile ? ` → ${profile.name}` : ''}
                      </td>
                      <td>{plan ? `${plan.emotion ?? '(默认)'}${actual}` : '—'}</td>
                      <td>{st?.state === 'ready' ? EMO_MODE_TEXT[st.mode] : '—'}</td>
                      <td className={st?.state === 'error' ? 'miss' : st?.state === 'ready' ? 'ok' : ''}>
                        {plan ? clipText(st) : why}
                        {/* 实际送去合成的字(日语声音念的是日语) */}
                        {plan && <div className="vn-console-sub">{plan.text}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="vn-console-section">
        <div className="vn-console-title">模型完整输出</div>
        <pre className="vn-console-raw">{raw ? highlighted : '(空)'}</pre>
      </div>
    </div>
  );
}

function clipText(st: ClipState | undefined): string {
  if (!st) return '还没请求';
  switch (st.state) {
    case 'queued':
      return '排队中';
    case 'loading':
      return '合成中…';
    case 'ready':
      return `✓ ${st.cache === 'hit' ? '缓存命中' : '新合成'} · ${(st.ms / 1000).toFixed(1)} 秒`;
    case 'error':
      return `✗ ${st.message}`;
  }
}
