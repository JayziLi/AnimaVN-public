import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './debug.css';
import { CardEditorDrawer } from './components/CardEditorDrawer';
import { AnimaIcon } from './components/AnimaIcon';
import { ChatHistoryOverlay, type ChatOp } from './components/ChatHistoryOverlay';
import { CardBindings } from './components/CardBindings';
import { CardPanel, type CardView, type SaveState } from './components/CardPanel';
import { ChatPanel } from './components/ChatPanel';
import { ConnectionsDrawer } from './components/ConnectionsDrawer';
import { CropModal } from './components/CropModal';
import { PersonaDrawer } from './components/PersonaDrawer';
import { PluginsDrawer, type PluginFocus, type PluginKey } from './components/PluginsDrawer';
import { SettingsDrawer } from './components/SettingsDrawer';
import { avatarOf } from './lib/avatar';
import { uuid } from '../lib/uuid';
import { MOBILE_QUERY, useIsMobile } from './lib/useIsMobile';
import {
  loadChatSettings,
  saveChatSettings,
  type ChatSettings,
} from './lib/chatSettings';
import { buildMacroContext } from './lib/macros';
import {
  loadCustomMacros,
  saveCustomMacros,
  toLookup,
  type CustomMacro,
} from './lib/customMacros';
import { BudgetBar } from './components/BudgetBar';
import { PresetPanel } from './components/PresetPanel';
import { PromptInspector } from './components/PromptInspector';
import { assemble, type AssemblyResult, type BudgetReport, type ChatTurn } from './lib/assembler';
import {
  debugApi,
  type CardSprite,
  type ChatPayload,
  type ChatSummary,
  type DebugPersona,
  type StoredCard,
  type StoredPreset,
} from './lib/api';
import {
  addTruncatedSwipe,
  appendSwipe,
  currentText,
  dropSwipe,
  fromStored,
  makeGreetingEntry,
  makePendingEntry,
  makeUserEntry,
  overswipeOf,
  patchSwipeInfo,
  setSwipeText,
  swipeTo,
  toStored,
  type ChatEntry,
  type SwipeInfo,
} from './lib/chatEntry';
import { resolveMarkerSource } from './lib/cardFields';
import { EMPTY_CARD, parseCardFile, type TavernCard } from './lib/cardParser';
import { cardFromStored, cardToFileJson, cardToStored, fileToDataUrl } from './lib/cardStore';
import {
  buildPresetSkeleton,
  parsePreset,
  pickDefaultOrderGroup,
  type PresetOrderEntry,
  type PresetPrompt,
  type TavernPreset,
} from './lib/presetParser';
import { presetFromStored, presetToFileJson, presetToStored } from './lib/presetStore';
import { loadLastPresetId, saveLastPresetId } from './lib/lastPreset';
import {
  DEFAULT_SPRITE_CONFIG,
  SPRITE_BLOCK_ID,
  SPRITE_SETTING_KEY,
  insertSpriteBlock,
  normalizeSpriteConfig,
  spriteBlockState,
  spriteMacros,
  type SpritePluginConfig,
} from './plugins/sprite';
import {
  SCENE,
  insertSceneBlock,
  sceneAtEnd,
  sceneBlockState,
  sceneMacros,
  sceneTagKind,
} from './plugins/scene';
import { useScenePlugin } from './plugins/useScenePlugin';
import { useSpriteLayout } from './plugins/useSpriteLayout';
import { useVoicePlugin } from './plugins/useVoicePlugin';
import { enabledOnly, isPluginBlock, syncPluginBlocks } from './plugins/common';
import {
  DEFAULT_LANG_CONFIG,
  LANG_BLOCK_ID,
  LANG_SETTING_KEY,
  insertLangBlock,
  langBlockState,
  normalizeLangConfig,
  type LangPluginConfig,
} from './plugins/lang';
import {
  DEFAULT_PLAYER_CONFIG,
  PLAYER_BLOCK_ID,
  PLAYER_SETTING_KEY,
  insertPlayerBlock,
  normalizePlayerConfig,
  playerBlockState,
  type PlayerPluginConfig,
} from './plugins/player';
import {
  EMPTY_BINDINGS,
  PERSONA_BINDING_KEY,
  bindCard,
  normalizeBindings,
  personaForCard,
  type PersonaBindings,
} from './lib/personaBinding';
import {
  EMPTY_PRESET_BINDINGS,
  PRESET_BINDING_KEY,
  forgetPreset,
  normalizePresetBindings,
  presetForCard,
  type PresetBindings,
} from './lib/presetBinding';
import { bgmPlayer } from './vn/bgm';
import { VNSaves } from './vn/VNSaves';
import { VNScreen } from './vn/VNScreen';
import { stripTags, vnTagKinds } from './vn/tags';
import {
  autoRange,
  DEFAULT_BUDGET,
  loadBudget,
  loadRange,
  saveBudget,
  saveRange,
} from './lib/budget';

const EMPTY_BUDGET: BudgetReport = {
  limit: null,
  fixedTokens: 0,
  presetTokens: 0,
  cardTokens: 0,
  historyTokens: 0,
  parts: { preset: 0, card: 0, persona: 0, examples: 0, worldInfo: 0, history: 0 },
  droppedCount: 0,
  droppedTokens: 0,
  overflow: false,
  forcedLastMessage: false,
  firstKeptHistoryIndex: null,
};

const EMPTY_RESULT: AssemblyResult = {
  messages: [],
  skipped: [],
  totalTokens: 0,
  danglingIdentifiers: [],
  budget: EMPTY_BUDGET,
};

/** 选卡时自动换人设 / 预设要说的一句话;选卡时几句合成一条提示。null = 没换 */
type Said = { kind: 'ok' | 'error'; text: string } | null;

const PANEL_MIN = 230;
const PANEL_MAX = 560;
const DEFAULT_LEFT = 330;
const DEFAULT_RIGHT = 350;

function clampPanel(v: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, v));
}

const two = (n: number) => String(n).padStart(2, '0');

/** 下拉里怎么称呼一张对话:有名用名,没名用「更新时间 · 条数」 */
function chatLabel(c: ChatSummary): string {
  if (c.name) return c.name;
  const d = new Date(c.updated_at);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} · ${c.message_count} 条`;
}

function loadPanelWidth(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? clampPanel(n) : fallback;
}

/** 聊天列保底宽度 —— 两个侧栏的持久化宽度可能是在大屏上拖出来的,
    换个小窗载入时加起来会超窗口,把 minmax(0,1fr) 的聊天列压成 0 */
const CHAT_MIN = 420;

/** 按当前窗口宽把两栏的持久化宽度收一收。挂载时算一次,
    从移动端布局切回桌面端时再算一次 —— 在手机尺寸挂载的话,
    innerWidth - CHAT_MIN 是负的,两栏会被压到 PANEL_MIN 那一档 */
function fitPanels(): { left: number; right: number } {
  const left = loadPanelWidth('debug.leftW', DEFAULT_LEFT);
  const right = loadPanelWidth('debug.rightW', DEFAULT_RIGHT);
  // 两栏加起来最多能占这么宽,剩下的归聊天列
  const budget = window.innerWidth - CHAT_MIN;
  if (left + right <= budget) return { left, right };
  // 装不下就按各自占比一起收。早先是「左栏先吃满、右栏拿剩下的」——
  // 左栏存着 496 时右栏被压到下限,聊天列还是只剩 300,等于 CHAT_MIN 没兜住
  const scale = budget / (left + right);
  return {
    left: clampPanel(Math.floor(left * scale)),
    right: clampPanel(Math.floor(right * scale)),
  };
}

export default function DebugApp() {
  const [card, setCard] = useState<TavernCard | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // 预设原样(插件块的正文可能是旧副本);对外一律用下面同步过插件模板的 preset
  const [rawPreset, setPreset] = useState<TavernPreset | null>(null);
  const [groupIndex, setGroupIndex] = useState(0);
  /** 编排的本地覆盖:identifier → enabled。用户在左栏点开关只改这里,不动原预设 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // 预设持久化:saved 是库里的列表,presetId 是当前选中的,dirty 表示有未写回的改动
  const [savedPresets, setSavedPresets] = useState<StoredPreset[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetDirty, setPresetDirty] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);

  // 角色卡持久化 —— 和预设不同,这边是自动保存
  const [savedCards, setSavedCards] = useState<StoredCard[]>([]);
  const [cardId, setCardId] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  /**
   * 导入/导出的遮罩文案。这类动作要解析文件、写库、再把卡和它的对话接上,
   * 慢的时候有一两秒;不盖点东西上去用户会以为按钮没响应,又点一遍。
   * null = 没有在跑的动作。
   */
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [cardSaveState, setCardSaveState] = useState<SaveState>('idle');
  const [showAdvanced, setShowAdvanced] = useState(false);
  /**
   * 右栏在编辑还是列表 —— 列表和编辑器共用那块面板,点 ☰ 互换,选完卡自动回编辑。
   * 开局是列表:进来没有选中的卡(停在开始界面),右栏直接摊开角色列表,
   * 挑一个就是一次点击的事;编辑器这时候没有卡可编。
   */
  const [cardView, setCardView] = useState<CardView>('list');
  /** 列表行的头像缓存:data URL 都在库里,按 id 懒加载,拉到就留着 */
  const [cardAvatars, setCardAvatars] = useState<Map<string, string>>(new Map());

  // 玩家人设:全局一份(后端 /api/personas),激活的那个决定 {{user}} 与人设描述。
  // userName/persona 仍是组装的直接输入,只是不再手填,而是由激活人设喂进来
  const [userName, setUserName] = useState('User');
  const [persona, setPersona] = useState('');
  const [personas, setPersonas] = useState<DebugPersona[]>([]);
  /** 顶栏模型下拉的 ⟳ 正在拉列表 */
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  /**
   * 待裁剪的头像 —— 选完文件先进裁剪弹窗,确认后才写回。
   * 卡头像和人设头像共用这一套,target 决定裁完写去哪。
   */
  const [cropTask, setCropTask] = useState<{
    file: File;
    target: { kind: 'card' } | { kind: 'persona'; id: string };
  } | null>(null);
  /** 这次选文件是给谁挑头像的 —— file input 是共用的,点之前先记下 */
  const avatarTargetRef = useRef<{ kind: 'card' } | { kind: 'persona'; id: string }>({
    kind: 'card',
  });
  /** 抽屉里也能换头像,所以开弹窗的动作要能被别人调 */
  const pickAvatarFor = (target: { kind: 'card' } | { kind: 'persona'; id: string }) => {
    avatarTargetRef.current = target;
    avatarInputRef.current?.click();
  };

  // token 预算:localStorage 有就用(包括明确关掉的 'off');从没设过就等
  // 预设载入后拿它的 openai_max_context 播种,再没有就 16384
  const [tokenBudget, setTokenBudget] = useState<number | null | undefined>(() => loadBudget());
  const budgetSeeded = useRef(loadBudget() !== undefined);
  const [rangeScale, setRangeScale] = useState(() => {
    const saved = loadRange();
    if (saved) return saved;
    const b = loadBudget();
    return autoRange(typeof b === 'number' ? b : DEFAULT_BUDGET);
  });

  useEffect(() => {
    if (budgetSeeded.current || !rawPreset) return;
    budgetSeeded.current = true;
    const fromPreset = Number(rawPreset.params.openai_max_context);
    const seeded =
      Number.isFinite(fromPreset) && fromPreset > 0 ? Math.floor(fromPreset) : DEFAULT_BUDGET;
    setTokenBudget(seeded);
    // 播种值不写 localStorage —— 那是用户的旋钮,预设只提供初值
    setRangeScale((r) => (seeded > r ? autoRange(seeded) : r));
  }, [rawPreset]);

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 对话被改过没有(编辑/删除/发消息)。对应酒馆的 chat_metadata.tainted ——
      没被改过的开场白右滑只在其他开场白之间循环,改过之后才会真的重新生成 */
  const [tainted, setTainted] = useState(false);

  // 对话持久化:chatId 是当前对话,chats 是当前卡的对话列表(顶栏下拉)
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  // 分支树要的视角:当前卡 + 孤儿对话(card_id 为空)。顶栏下拉只给当前卡的,
  // 树这边多挂孤儿,让导入后匹配不到卡的对话有地方进
  const [treeChats, setTreeChats] = useState<ChatSummary[]>([]);

  // ---- 加载指示 ----
  // 开机首屏:预设 + 卡 + 最近对话是一串串行请求,期间盖一层遮罩,
  // 免得用户看着界面一格格长出来以为是坏的
  const [booting, setBooting] = useState(true);
  /** 正在读某张对话(切对话/切卡/分叉后跳转) */
  const [chatLoading, setChatLoading] = useState(false);
  /** 分支树在重建 */
  const [treeLoading, setTreeLoading] = useState(false);
  /** 树头上哪个耗时动作在跑 */
  const [chatOp, setChatOp] = useState<ChatOp>(null);

  /** 对话历史盖在聊天区上 —— 左栏只留一颗按钮,不再跟预设抢高度 */
  const [showHistory, setShowHistory] = useState(false);

  const [connections, setConnections] = useState<
    Awaited<ReturnType<typeof debugApi.listConnections>>
  >([]);
  const [connectionId, setConnectionId] = useState<string | undefined>();
  const [version, setVersion] = useState('');

  const [inspecting, setInspecting] = useState<AssemblyResult | null>(null);
  const [lastRaw, setLastRaw] = useState<string | null>(null);
  // 移动端两侧面板是盖住聊天区的全屏抽屉 —— 开局就得是收起的,
  // 否则一进来看到的是预设面板而不是对话。初值直接问媒体查询,免得先摊开再收一帧
  const startsMobile = () => window.matchMedia(MOBILE_QUERY).matches;
  const [leftCollapsed, setLeftCollapsed] = useState(startsMobile);
  const [rightCollapsed, setRightCollapsed] = useState(startsMobile);
  // 设置 / API / 玩家三个抽屉盖的是聊天区顶部同一块地方,同时只能开一个 ——
  // 三个布尔量互相关掉容易漏,直接用一个「当前开着谁」
  const [drawer, setDrawer] = useState<'settings' | 'api' | 'persona' | 'plugins' | null>(null);
  const toggleDrawer = (d: 'settings' | 'api' | 'persona' | 'plugins') => {
    // 移动端这几个入口藏在 ⋯ 菜单里,点完得把菜单收掉,否则抽屉和菜单叠着
    setMobileMenu(false);
    // 从顶栏正常打开插件抽屉,不沿用上次从左栏跳过来时要滚到的位置
    setPluginFocus(null);
    setDrawer((cur) => (cur === d ? null : d));
  };

  // 移动端:预设、角色卡是一级入口;玩家/设置/连接/模型是次要入口,折进 ⋯ 菜单。
  const isMobile = useIsMobile();
  const [mobileMenu, setMobileMenu] = useState(false);
  useEffect(() => {
    if (!isMobile) setMobileMenu(false);
  }, [isMobile]);
  // 转屏 / 拉窗口跨过断点时重定基线:进移动端收起两栏(理由同上),回桌面端摊开
  useEffect(() => {
    setLeftCollapsed(isMobile);
    setRightCollapsed(isMobile);
    // 在手机尺寸挂载时两栏宽被压到了最窄一档,回桌面端得按新窗口宽重算,
    // 否则三栏一直是 230+230 那副样子(localStorage 里其实存着更宽的值)
    if (!isMobile) {
      const fit = fitPanels();
      setLeftW(fit.left);
      setRightW(fit.right);
    }
  }, [isMobile]);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  /** 聊天区的显示偏好。纯前端,改一次写一次 localStorage */
  const [chatSettings, setChatSettings] = useState<ChatSettings>(loadChatSettings);
  const changeChatSettings = (next: ChatSettings) => {
    setChatSettings(next);
    saveChatSettings(next);
  };

  /**
   * 自定义宏。和显示偏好分开存 —— 它会进提示词,不是「我的眼睛怎么舒服」,
   * 「恢复默认」也不该顺手把人写的宏清空。
   */
  const [customMacros, setCustomMacros] = useState<CustomMacro[]>(loadCustomMacros);
  const changeCustomMacros = (next: CustomMacro[]) => {
    setCustomMacros(next);
    saveCustomMacros(next);
  };

  /**
   * 立绘插件:全局配置(标签格式 + 提示词模板)存后端,手机和电脑共用;
   * 表情映射跟着当前卡走。改配置时先改内存,停手半秒再写库,免得每敲一个字发一次请求。
   */
  const [spriteConfig, setSpriteConfig] = useState<SpritePluginConfig>(DEFAULT_SPRITE_CONFIG);
  const spriteSaveTimer = useRef<number | undefined>(undefined);
  const changeSpriteConfig = (next: SpritePluginConfig) => {
    setSpriteConfig(next);
    window.clearTimeout(spriteSaveTimer.current);
    spriteSaveTimer.current = window.setTimeout(() => {
      debugApi
        .putSetting(SPRITE_SETTING_KEY, next)
        .catch((e: unknown) =>
          notify('error', `插件配置保存失败: ${e instanceof Error ? e.message : String(e)}`),
        );
    }, 500);
  };
  const [sprites, setSprites] = useState<CardSprite[]>([]);

  /** 外语插件(日语配音、中文字幕):全局配置,和立绘插件一样停手半秒再写库 */
  const [langConfig, setLangConfig] = useState<LangPluginConfig>(DEFAULT_LANG_CONFIG);
  const langSaveTimer = useRef<number | undefined>(undefined);
  const changeLangConfig = (next: LangPluginConfig) => {
    setLangConfig(next);
    window.clearTimeout(langSaveTimer.current);
    langSaveTimer.current = window.setTimeout(() => {
      debugApi
        .putSetting(LANG_SETTING_KEY, next)
        .catch((e: unknown) =>
          notify('error', `插件配置保存失败: ${e instanceof Error ? e.message : String(e)}`),
        );
    }, 500);
  };

  /** 玩家台词插件(<我> 弹选项):全局配置,同样停手半秒再写库 */
  const [playerConfig, setPlayerConfig] = useState<PlayerPluginConfig>(DEFAULT_PLAYER_CONFIG);
  const playerSaveTimer = useRef<number | undefined>(undefined);
  const changePlayerConfig = (next: PlayerPluginConfig) => {
    setPlayerConfig(next);
    window.clearTimeout(playerSaveTimer.current);
    playerSaveTimer.current = window.setTimeout(() => {
      debugApi
        .putSetting(PLAYER_SETTING_KEY, next)
        .catch((e: unknown) =>
          notify('error', `插件配置保存失败: ${e instanceof Error ? e.message : String(e)}`),
        );
    }, 500);
  };

  // 视觉小说模式。刻意不跨刷新保留:开机不会自动选角色卡,刷新后直接进视觉小说
  // 只会看到一个「先选卡」的空界面 —— 还不如回到开始界面,选完卡再点一次入口
  const [vnOpen, setVnOpen] = useState(false);
  const toggleVn = (open: boolean) => {
    setMobileMenu(false);
    // 进入按钮这一下点击就是用户手势:趁这时解锁音频,进去就能响(iOS 只认手势里的解锁)
    if (open) bgmPlayer.unlock();
    setVnOpen(open);
  };

  // 三栏宽度:初始从 localStorage 恢复,拖动时实时更新,松手时持久化。
  // 恢复时以「聊天列至少 CHAT_MIN」收一收两栏 —— 只收载入值,拖动仍按用户手上的来
  const [leftW, setLeftW] = useState(() => fitPanels().left);
  const [rightW, setRightW] = useState(() => fitPanels().right);
  const draggingSide = useRef<'left' | 'right' | null>(null);

  const toastTimer = useRef<number | undefined>(undefined);
  const cardInputRef = useRef<HTMLInputElement | null>(null);
  const presetInputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 正在跑的那次生成,跑完(含被停下)才 resolve —— 插话要等它收完尾再接着发 */
  const inflightRef = useRef<Promise<void>>(Promise.resolve());
  // 逐操作写库的水位线(见 persist effect):条目对象或位置变了才需要写
  const persistedRef = useRef<{
    chatId: string | null;
    rows: Map<string, { entry: ChatEntry; idx: number }>;
  }>({ chatId: null, rows: new Map() });
  const taintedRef = useRef(false);
  const metaRef = useRef<{ card_id: string | null; preset_id: string | null; user_name: string }>(
    { card_id: null, preset_id: null, user_name: 'User' },
  );
  // 历史提示词快照的内存缓存 —— 读回的对话只有哈希,点开才按哈希取
  const snapCache = useRef(new Map<string, AssemblyResult>());
  // 快速连续切换对话/卡片时,让在途的加载作废,后到的赢
  const chatSeq = useRef(0);
  // selectCard 也是一串串行 await(头像→对话列表→接对话),连点两张卡时
  // 前一张的慢响应会把后一张的头像/对话列表盖掉 —— 和 chatSeq 同款的守卫
  const cardSeq = useRef(0);
  // 自动保存的 debounce 计时器 + 保存态复位计时器
  const cardSaveTimer = useRef<number | undefined>(undefined);
  const savedFlagTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((kind: 'ok' | 'error', message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ kind, message });
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  /** 背景 / BGM 插件:配置、场景包、当前卡绑的包和素材 */
  const scenePlugin = useScenePlugin(cardId, notify);
  /** 语音插件:配置、语音服务、声音,以及当前卡用哪些声音 */
  const voicePlugin = useVoicePlugin(cardId, notify);
  // 游戏、提示词、语音、存档缩略图只看没禁用的素材;插件抽屉拿完整列表,好重新打开
  const activeSprites = useMemo(() => enabledOnly(sprites), [sprites]);
  const activeSceneAssets = useMemo(() => enabledOnly(scenePlugin.assets), [scenePlugin.assets]);
  const sceneKinds = useMemo(
    () => [
      sceneTagKind('bg', scenePlugin.configs.bg.tagTemplate),
      sceneTagKind('bgm', scenePlugin.configs.bgm.tagTemplate),
    ],
    [scenePlugin.configs],
  );
  // 整段对话末尾是哪个场景、在放哪首 —— {{current_bg}} / {{current_bgm}}
  const sceneNow = useMemo(
    () => sceneAtEnd(entries, sceneKinds, activeSceneAssets),
    [entries, sceneKinds, activeSceneAssets],
  );
  const sceneMacroValues = useMemo(
    () =>
      sceneMacros(scenePlugin.configs, scenePlugin.packId !== null, activeSceneAssets, sceneNow),
    [scenePlugin.configs, scenePlugin.packId, activeSceneAssets, sceneNow],
  );

  // 插件块的正文只认插件里的提示词模板(全局一份)。预设里存的只是副本,读的时候
  // 换成模板 —— 组装、左栏显示、保存、导出用的都是这个同步过的 preset
  const pluginTemplates = useMemo(
    () => ({
      [SPRITE_BLOCK_ID]: spriteConfig.blockPrompt,
      [SCENE.bg.blockId]: scenePlugin.configs.bg.blockPrompt,
      [SCENE.bgm.blockId]: scenePlugin.configs.bgm.blockPrompt,
      [LANG_BLOCK_ID]: langConfig.blockPrompt,
      [PLAYER_BLOCK_ID]: playerConfig.blockPrompt,
    }),
    [spriteConfig.blockPrompt, scenePlugin.configs, langConfig.blockPrompt, playerConfig.blockPrompt],
  );
  const preset = useMemo(
    () => syncPluginBlocks(rawPreset, pluginTemplates),
    [rawPreset, pluginTemplates],
  );

  /** 插件抽屉要打开到哪个插件的提示词模板;nonce 让连点同一个也能再跳一次 */
  const [pluginFocus, setPluginFocus] = useState<{ section: PluginKey; nonce: number } | null>(
    null,
  );
  /** 左栏点插件块:不在预设里改,跳到插件抽屉里它的提示词模板 */
  /** 预设里的插件块 → 它属于哪个插件 */
  const pluginOfBlock = (identifier: string): PluginKey =>
    identifier === SCENE.bg.blockId
      ? 'bg'
      : identifier === SCENE.bgm.blockId
        ? 'bgm'
        : identifier === LANG_BLOCK_ID
          ? 'lang'
          : identifier === PLAYER_BLOCK_ID
            ? 'player'
            : 'sprite';

  const openPluginEditor = (identifier: string) => {
    const section = pluginOfBlock(identifier);
    setMobileMenu(false);
    // 手机上左栏是盖在聊天区上的,不收起来就看不到抽屉
    if (isMobile) setLeftCollapsed(true);
    setDrawer('plugins');
    setPluginFocus({ section, nonce: Date.now() });
  };

  // 插件的宏({{sprites}}、{{backgrounds}}、{{current_bg}} …)和自定义宏并进同一张查找表 ——
  // 组装提示词和聊天区显示用的都是它,两边展开结果一致。插件宏放后面,同名时插件优先
  const macroLookup = useMemo(
    () => ({
      ...toLookup(customMacros),
      ...spriteMacros(spriteConfig, activeSprites),
      ...sceneMacroValues,
    }),
    [customMacros, spriteConfig, activeSprites, sceneMacroValues],
  );

  /**
   * 拉人设并把激活的那个套进组装输入。
   * 一个人设都没有时回退到 'User' —— 和没接人设系统之前的行为一致。
   */
  const refreshPersonas = useCallback(async () => {
    try {
      const list = await debugApi.listPersonas();
      setPersonas(list);
      const active = list.find((p) => p.is_active) ?? null;
      setUserName(active ? active.name : 'User');
      setPersona(active ? active.description : '');
    } catch (e) {
      notify('error', `人设列表拉取失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [notify]);

  const activePersona = personas.find((p) => p.is_active) ?? null;

  /** 人设绑角色卡:选卡时自动切到它绑的人设,没绑切回默认人设(见 lib/personaBinding.ts) */
  const [personaBindings, setPersonaBindings] = useState<PersonaBindings>(EMPTY_BINDINGS);
  const changePersonaBindings = (next: PersonaBindings) => {
    setPersonaBindings(next);
    debugApi
      .putSetting(PERSONA_BINDING_KEY, next)
      .catch((e: unknown) =>
        notify('error', `人设绑定保存失败: ${e instanceof Error ? e.message : String(e)}`),
      );
  };
  // selectCard 是 useCallback,读最新的绑定和人设列表走 ref
  const personaRef = useRef({ bindings: personaBindings, personas });
  personaRef.current = { bindings: personaBindings, personas };

  /**
   * 选中一张卡时套用它的人设;已经是那个就不动。不直接弹提示,返回要说的话 ——
   * 选卡时和预设的合成一条。bindings 默认用存着的,卡编辑器里刚改的绑定直接传进来
   */
  const applyBoundPersona = useCallback(
    async (forCardId: string, bindings = personaRef.current.bindings): Promise<Said> => {
      const { personas: list } = personaRef.current;
      const target = personaForCard(
        bindings,
        forCardId,
        list.map((p) => p.id),
      );
      const active = list.find((p) => p.is_active);
      if (!target || target.id === active?.id) return null;
      try {
        await debugApi.activatePersona(target.id);
        await refreshPersonas();
        const name = list.find((p) => p.id === target.id)?.name ?? '';
        return { kind: 'ok', text: `人设换成了「${name}」(${target.bound ? '这张卡绑定的' : '默认人设'})` };
      } catch (e) {
        return { kind: 'error', text: `人设切换失败: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    [refreshPersonas],
  );

  /** 预设绑角色卡:选卡、开这张卡的对话时换成绑定的预设,比对话记的优先(见 lib/presetBinding.ts) */
  const [presetBindings, setPresetBindings] = useState<PresetBindings>(EMPTY_PRESET_BINDINGS);
  const changePresetBindings = (next: PresetBindings) => {
    setPresetBindings(next);
    debugApi
      .putSetting(PRESET_BINDING_KEY, next)
      .catch((e: unknown) =>
        notify('error', `预设绑定保存失败: ${e instanceof Error ? e.message : String(e)}`),
      );
  };
  // selectCard / loadChat 是 useCallback,读最新的绑定、预设列表、当前预设走 ref
  const presetRef = useRef({ bindings: presetBindings, saved: savedPresets, id: presetId, dirty: presetDirty });
  presetRef.current = { bindings: presetBindings, saved: savedPresets, id: presetId, dirty: presetDirty };

  /** 人设头像:裁完的 blob 转 data URL 存库,和卡头像一个存法 */
  const changePersonaAvatar = async (personaId: string, blob: Blob) => {
    try {
      const dataUrl = await fileToDataUrl(blob);
      await debugApi.updatePersona(personaId, { avatar: dataUrl });
      await refreshPersonas();
      notify('ok', '人设头像已更新');
    } catch (e) {
      notify('error', `人设头像更新失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const refreshConnections = useCallback(async () => {
    try {
      const list = await debugApi.listConnections();
      setConnections(list);
      // 顶栏「连接」和 API 设置抽屉共用同一个后端 is_active 标记,
      // 谁选了都立刻 activate,这里只需老实跟着它走,两边就自然同步
      setConnectionId(list.find((c) => c.is_active)?.id ?? list[0]?.id);
    } catch (e) {
      notify('error', `连接列表拉取失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [notify]);

  /** 顶栏「连接」下拉选中即启用 —— 和 API 设置抽屉的选中即启用是同一套语义 */
  const selectConnection = useCallback(
    (id: string) => {
      if (!id || id === connectionId) return;
      debugApi
        .activateConnection(id)
        .then(refreshConnections)
        .catch((e: unknown) =>
          notify('error', `切换连接失败: ${e instanceof Error ? e.message : String(e)}`),
        );
    },
    [connectionId, notify, refreshConnections],
  );

  /** 刷新分支树:当前卡 + 孤儿对话(card_id 为空)。显式传卡 id,免得拿到旧闭包 */
  const refreshTree = useCallback(async (forCardId: string | null) => {
    setTreeLoading(true);
    try {
      const all = await debugApi.listChats(null);
      setTreeChats(all.filter((c) => c.card_id === forCardId || c.card_id === null));
    } catch {
      // 树是辅助导航,拉取失败不弹错 —— 顶栏下拉和对话本身才是主路径
    } finally {
      setTreeLoading(false);
    }
  }, []);

  /** 选中一个已存的预设:拉库 → 转成组装器形态 → 清掉临时开关 */
  const selectPreset = useCallback(
    (row: StoredPreset) => {
      try {
        const parsed = presetFromStored(row);
        setPreset(parsed);
        const picked = pickDefaultOrderGroup(parsed.orderGroups);
        setGroupIndex(picked ? parsed.orderGroups.indexOf(picked) : 0);
        setOverrides({});
        setPresetId(row.id);
        setPresetDirty(false);
        // 记成「上次打开的预设」,下次进来默认还是它(酒馆的行为)。
        // 放在这里而不是各个调用点:选预设的入口有好几个(下拉、导入、另存、
        // 读对话时恢复当时的预设),它们最终都会走到这儿
        saveLastPresetId(row.id);
      } catch (e) {
        notify('error', `预设读取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [notify],
  );

  /**
   * 这张卡绑了预设就换过去;没绑、绑的删了、已经是它都不动。和人设一样返回要说的话。
   * 当前预设有没保存的改动时不换 —— 换了改动就丢了
   */
  const applyBoundPreset = useCallback(
    (forCardId: string | null, bindings = presetRef.current.bindings): Said => {
      const { saved, id, dirty } = presetRef.current;
      const target = presetForCard(
        bindings,
        forCardId,
        saved.map((p) => p.id),
      );
      const row = saved.find((p) => p.id === target);
      if (!row || row.id === id) return null;
      if (dirty) {
        return { kind: 'error', text: `预设有没保存的改动,没换成这张卡绑定的「${row.name}」` };
      }
      selectPreset(row);
      return { kind: 'ok', text: `预设换成了「${row.name}」(这张卡绑定的)` };
    },
    [selectPreset],
  );

  const refreshPresets = useCallback(
    async (selectId?: string) => {
      try {
        const list = await debugApi.listPresets();
        setSavedPresets(list);
        const target = selectId ? list.find((p) => p.id === selectId) : undefined;
        if (target) selectPreset(target);
        return list;
      } catch (e) {
        notify('error', `预设列表拉取失败: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },
    [notify, selectPreset],
  );

  /**
   * 记下「这张卡上次打开的是哪条对话」,对齐酒馆存在角色身上的 character.chat。
   *
   * 不这么记就只能按 updated_at 挑最近改过的那条,而读一条旧对话并不会动
   * updated_at —— 手动翻回一条老对话、切走再切回来,就会跳到别的对话上。
   *
   * 本地列表同步更新:同一次会话里连着切卡不用重新拉 listCards 也能挑对。
   * 写库失败不打扰用户 —— 书签丢了最多是回退成「最近更新的那条」。
   */
  const rememberLastChat = useCallback((forCardId: string, forChatId: string) => {
    setSavedCards((prev) =>
      prev.map((c) => (c.id === forCardId ? { ...c, last_chat_id: forChatId } : c)),
    );
    void debugApi.updateCard(forCardId, { last_chat_id: forChatId }).catch(() => {});
  }, []);

  /** 读回一张对话:条目、tainted、绑定的卡/预设/用户名各就各位 */
  /** 读一张对话并切过去。返回读到的条目;读失败、或中途又切走了返回 null */
  const loadChat = useCallback(
    async (id: string): Promise<ChatEntry[] | null> => {
      const seq = ++chatSeq.current;
      setChatLoading(true);
      // 收尾只认最后一次:中途切走了就把关灯的活儿留给接班的那次,
      // 否则作废的请求先返回会把还在转的圈提前关掉
      const settle = () => {
        if (seq === chatSeq.current) setChatLoading(false);
      };
      let detail;
      try {
        detail = await debugApi.getChat(id);
      } catch (e) {
        settle();
        notify('error', `对话读取失败: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      if (seq !== chatSeq.current) return null; // 中途又切走了,这次作废
      setChatId(detail.id);
      // 孤儿对话(card_id 为空)不记书签:它还不属于任何卡,等下面的收养 PATCH
      // 落库之后,下次再打开就带着 card_id 进来了
      if (detail.card_id) rememberLastChat(detail.card_id, detail.id);
      setChats((prev) =>
        prev.map((c) =>
          c.id === detail.id ? { ...detail, message_count: detail.messages.length } : c,
        ),
      );
      const mapped = detail.messages.map((m, i) => fromStored(m, i));
      setEntries(mapped);
      setTainted(detail.tainted);
      taintedRef.current = detail.tainted;
      metaRef.current = {
        card_id: detail.card_id,
        preset_id: detail.preset_id,
        user_name: detail.user_name,
      };
      persistedRef.current = {
        chatId: detail.id,
        rows: new Map(mapped.map((e, i) => [e.id, { entry: e, idx: i }] as const)),
      };
      // 人设是全局的:开旧对话不把当时的名字倒灌回来,只让它跟着当前激活人设走
      setError(null);
      // 卡绑了预设就用绑定的,不管这条对话当时用的哪套(选卡时一般已经换好,这里多半
      // 什么都不做);没绑才恢复这张对话当时用的预设(还在库里的话)—— 调试台要的是可复现
      const { bindings, saved } = presetRef.current;
      if (presetForCard(bindings, detail.card_id, saved.map((p) => p.id))) {
        const said = applyBoundPreset(detail.card_id);
        if (said?.kind === 'error') notify('error', said.text);
      } else if (detail.preset_id && detail.preset_id !== presetRef.current.id) {
        try {
          const row = await debugApi.getPreset(detail.preset_id);
          if (seq !== chatSeq.current) return null; // settle 交给接班的那次
          selectPreset(row);
        } catch {
          // 预设被删了:对话里的引用已经是空,不动当前选择
        }
      }
      settle();
      return mapped;
    },
    [selectPreset, applyBoundPreset, notify, rememberLastChat],
  );

  /** 另开一张新对话,旧的留在下拉里 —— 「清空对话」在持久化之后就是这个语义 */
  const newChat = useCallback(
    async (context?: { cardId: string; card: TavernCard }) => {
      // context 让 selectCard 在状态还没提交时也能带着新卡直接开聊
      const c = context?.card ?? card;
      const cid = context?.cardId ?? cardId;
      if (!c || !cid || sending) return;
      const seq = ++chatSeq.current;
      // 也接管 chatLoading:建对话同样是网络往返,而且这一跳会作废在途的 loadChat,
      // 那次的 settle 不会执行 —— 圈得由这里关
      setChatLoading(true);
      let created;
      try {
        created = await debugApi.createChat({
          card_id: cid,
          preset_id: presetId,
          user_name: userName,
        });
      } catch (e) {
        if (seq === chatSeq.current) setChatLoading(false);
        notify('error', `新建对话失败: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // 开场白就是 chat[0](酒馆的做法),其他开场白当成它的分支。
      //
      // 写库和记书签都放在「有没有被切走」之前:对话已经建出来了,这时候直接
      // 返回会在库里留一条没有开场白的空对话 —— 连点几张卡就攒一堆,下次进这
      // 张卡打开的就是一片空白。两个写的目标都是 created.id / cid,跟「现在在看
      // 哪张卡」无关,晚到也不会串到别人身上。
      const greeting = makeGreetingEntry(c);
      const seeded = greeting ? [greeting] : [];
      // persist effect 在「换对话」边沿只认账不回写,所以开场白得当场写
      seeded.forEach((entry, i) => {
        void debugApi.putChatMessage(created.id, toStored(entry, i)).catch((e: unknown) =>
          notify('error', `对话保存失败: ${e instanceof Error ? e.message : String(e)}`),
        );
      });
      rememberLastChat(cid, created.id);

      if (seq !== chatSeq.current) return; // 切走了:库里那条是完整的,只是不显示
      setChatLoading(false);
      setChatId(created.id);
      setChats((prev) => [{ ...created, message_count: seeded.length }, ...prev]);
      refreshTree(cid);
      setEntries(seeded);
      setTainted(false);
      taintedRef.current = false;
      metaRef.current = { card_id: cid, preset_id: presetId, user_name: userName };
      persistedRef.current = {
        chatId: created.id,
        rows: new Map(seeded.map((e, i) => [e.id, { entry: e, idx: i }] as const)),
      };
      setError(null);
    },
    [card, cardId, presetId, userName, sending, notify, refreshTree, rememberLastChat],
  );

  /**
   * 选中一张已存的卡:转成组装器形态,头像单独拉,然后接上它最近的对话。
   * fresh = 不接旧对话,直接开一段新的(视觉小说标题画面的「新的故事」)
   */
  const selectCard = useCallback(
    async (row: StoredCard, opts?: { fresh?: boolean }) => {
      const seq = ++cardSeq.current;
      const parsed = cardFromStored(row);
      setCard(parsed);
      setCardId(row.id);
      setCardSaveState('idle');
      // 这张卡绑了人设就换过去(没绑换回默认人设),{{user}} 在开场白里一开始就对;
      // 绑了预设也换过去 —— 要在开新对话之前,新对话记的就是它。两句合成一条提示
      const said = [await applyBoundPersona(row.id), applyBoundPreset(row.id)].filter(
        (s): s is NonNullable<Said> => s !== null,
      );
      if (said.length > 0) {
        notify(
          said.some((s) => s.kind === 'error') ? 'error' : 'ok',
          said.map((s) => s.text).join(';'),
        );
      }
      // 从列表点进来的:选完就回编辑器,列表只是选角色的入口
      setCardView('editor');
      setAvatarUrl((prev) => {
        // 库里的头像是 data URL,不是 object URL,但上一张可能是,该释放还得释放
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
      if (row.has_avatar) {
        const dataUrl = await debugApi.getCardAvatar(row.id);
        // 头像缓存按 id 存,谁先到都对;但编辑区的大图只认最后一次选择
        if (dataUrl) {
          setCardAvatars((prev) => {
            if (prev.get(row.id) === dataUrl) return prev;
            const next = new Map(prev);
            next.set(row.id, dataUrl);
            return next;
          });
          if (seq === cardSeq.current) setAvatarUrl(dataUrl);
        }
      }
      // 这张卡上次打开的那条对话,没有就开一张新的 —— 贴酒馆「每个角色有自己的对话」
      const list = await debugApi.listChats(row.id);
      if (seq !== cardSeq.current) return; // 中途又选了别的卡,这次作废
      setChats(list);
      refreshTree(row.id);
      // 书签可能悬空:那条对话被删了,或者被挪去了别的卡。list 里找不着就回退到
      // 最近更新的一条 —— 也就是没有书签之前的老行为
      const bookmarked = row.last_chat_id
        ? list.find((c) => c.id === row.last_chat_id)
        : undefined;
      const target = bookmarked ?? list[0];
      if (target && !opts?.fresh) {
        await loadChat(target.id);
      } else {
        await newChat({ cardId: row.id, card: parsed });
      }
    },
    [loadChat, newChat, refreshTree, applyBoundPersona, applyBoundPreset, notify],
  );

  /** 「从这里开始」—— 复制 [0, 该消息] 前缀到新分支,然后切过去 */
  const branchHere = useCallback(
    async (messageId: string) => {
      if (!chatId || sending || chatOp) return;
      setChatOp('branch');
      try {
        const created = await debugApi.branchChat(chatId, messageId);
        setChats(await debugApi.listChats(cardId));
        refreshTree(cardId);
        await loadChat(created.id);
        notify('ok', `已从这里分叉:「${created.name}」`);
      } catch (e) {
        notify('error', `分叉失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setChatOp(null);
      }
    },
    [chatId, cardId, sending, chatOp, loadChat, refreshTree, notify],
  );

  /**
   * 视觉小说的「在当前位置存档」:和分叉是同一个接口,但人留在原对话里接着玩 ——
   * 新分出来的那个对话就是存档,以后从存档页读回来
   */
  const saveBranch = useCallback(
    async (messageId: string | null) => {
      if (!chatId || !messageId || sending || chatOp) return;
      setChatOp('branch');
      try {
        const created = await debugApi.branchChat(chatId, messageId);
        setChats(await debugApi.listChats(cardId));
        refreshTree(cardId);
        notify('ok', `已存档:「${created.name}」`);
      } catch (e) {
        notify('error', `存档失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setChatOp(null);
      }
    },
    [chatId, cardId, sending, chatOp, refreshTree, notify],
  );

  /** 导入酒馆 jsonl 对话(可多选)。匹配到当前卡的会直接切过去看 */
  const importChats = async (files: File[]) => {
    if (files.length === 0 || chatOp) return;
    setChatOp('import');
    try {
      const created = await debugApi.importChats(files);
      setChats(await debugApi.listChats(cardId));
      refreshTree(cardId);
      const inView = created.find((c) => c.card_id === cardId);
      if (inView) await loadChat(inView.id);
      notify('ok', `已导入 ${created.length} 条对话`);
    } catch (e) {
      notify('error', `对话导入失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChatOp(null);
    }
  };

  /** 导出:整树要在后端打包 zip,大的话要等一会儿,所以也占一个 pending 位。
   *  id 省略就是导出当前对话;历史面板的行内导出把那一行的 id 传进来,
   *  省掉「先切过去再导」这一步 */
  const runExport = async (tree: boolean, id: string | null = chatId) => {
    if (!id || chatOp) return;
    setChatOp(tree ? 'exportTree' : 'export');
    try {
      await debugApi.exportChat(id, tree);
    } catch (e) {
      notify('error', `导出失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChatOp(null);
    }
  };

  /** 历史面板的行内重命名。名字只影响列表和导出文件名,不碰消息 */
  const renameChat = async (id: string, name: string) => {
    try {
      await debugApi.updateChat(id, { name });
      setChats(await debugApi.listChats(cardId));
      refreshTree(cardId);
    } catch (e) {
      notify('error', `重命名失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 历史面板的行内删除。删掉的正好是当前这条就得换一条,否则界面还挂在
   *  一个已经不存在的 chatId 上 —— 之后任何一次消息回写都会 404 */
  const removeChat = async (id: string) => {
    try {
      await debugApi.deleteChat(id);
      const list = await debugApi.listChats(cardId);
      setChats(list);
      refreshTree(cardId);
      if (id === chatId) {
        const next = list.find((c) => c.id !== id);
        if (next) await loadChat(next.id);
        else await newChat();
      }
      notify('ok', '已删除对话');
    } catch (e) {
      notify('error', `删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 历史分支的「看提示词」:在库的按哈希取(带缓存),这会儿在内存的直接看 */
  const inspectSwipe = useCallback(
    async (info: SwipeInfo) => {
      if (info.snapshot) {
        setInspecting(info.snapshot);
        return;
      }
      if (!info.snapshotHash) return;
      const cached = snapCache.current.get(info.snapshotHash);
      if (cached) {
        setInspecting(cached);
        return;
      }
      try {
        const payload = await debugApi.getSnapshot(info.snapshotHash);
        snapCache.current.set(info.snapshotHash, payload);
        setInspecting(payload);
      } catch (e) {
        notify('error', `快照读取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [notify],
  );

  // 只跑一次:StrictMode 会双跑 effect,第二跑会把第一跑刚建的对话再建一份
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    refreshConnections();
    refreshPersonas();
    debugApi
      .getSetting(SPRITE_SETTING_KEY)
      .then((v) => {
        if (v !== null) setSpriteConfig(normalizeSpriteConfig(v));
      })
      .catch((e: unknown) =>
        notify('error', `插件配置读取失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    debugApi
      .getSetting(PERSONA_BINDING_KEY)
      .then((v) => {
        if (v !== null) setPersonaBindings(normalizeBindings(v));
      })
      .catch((e: unknown) =>
        notify('error', `人设绑定读取失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    debugApi
      .getSetting(PRESET_BINDING_KEY)
      .then((v) => {
        if (v !== null) setPresetBindings(normalizePresetBindings(v));
      })
      .catch((e: unknown) =>
        notify('error', `预设绑定读取失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    debugApi
      .getSetting(LANG_SETTING_KEY)
      .then((v) => {
        if (v !== null) setLangConfig(normalizeLangConfig(v));
      })
      .catch((e: unknown) =>
        notify('error', `外语插件配置读取失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    debugApi
      .getSetting(PLAYER_SETTING_KEY)
      .then((v) => {
        if (v !== null) setPlayerConfig(normalizePlayerConfig(v));
      })
      .catch((e: unknown) =>
        notify('error', `玩家台词插件配置读取失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    debugApi
      .health()
      .then((h) => setVersion(h.version))
      .catch(() => setVersion(''));
    // 开局恢复上次用的预设,但**不**自动选角色卡 —— 每次进来停在开始界面,
    // 由用户挑角色。预设是全局配置(酒馆也是关掉再开还是那套),角色卡是
    // 「这次想聊谁」,不该替人决定。
    // deps 必须为空:selectPreset 进 deps 会在读对话恢复预设时身份变化 →
    // 开机重跑 → 又选回上次那个 → 振荡
    void (async () => {
      try {
        const list = await debugApi.listPresets();
        setSavedPresets(list);
        // 记着的那个可能已经被删了,找不着就退回第一个
        const remembered = loadLastPresetId();
        const target = (remembered && list.find((p) => p.id === remembered)) || list[0];
        if (target) selectPreset(target);
      } catch (e) {
        notify('error', `预设列表拉取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        setSavedCards(await debugApi.listCards());
      } catch (e) {
        notify('error', `角色卡列表拉取失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时清掉挂着的计时器,免得组件没了还在跑
  useEffect(
    () => () => {
      window.clearTimeout(cardSaveTimer.current);
      window.clearTimeout(savedFlagTimer.current);
      window.clearTimeout(spriteSaveTimer.current);
    },
    [],
  );

  // 换卡就换一套表情映射。切得快时旧请求可能后到 —— 只收当前这张卡的结果
  const spriteCardRef = useRef<string | null>(null);
  useEffect(() => {
    spriteCardRef.current = cardId;
    setSprites([]);
    if (!cardId) return;
    debugApi
      .listSprites(cardId)
      .then((list) => {
        if (spriteCardRef.current === cardId) setSprites(list);
      })
      .catch((e: unknown) =>
        notify('error', `表情映射读取失败: ${e instanceof Error ? e.message : String(e)}`),
      );
  }, [cardId, notify]);
  const changeSprites = (forCard: string, next: CardSprite[]) => {
    if (spriteCardRef.current === forCard) setSprites(next);
  };
  /** 立绘怎么摆:所有角色共用的构图、当前卡的微调,顺带给没找过脸的立绘补识别 */
  const spriteLayout = useSpriteLayout(cardId, sprites, changeSprites, notify);

  /**
   * 列表视图的头像懒加载:不进列表一张都不拉(data URL 都不小);
   * 进了列表把没拉过的并发取回来,拉到进 cardAvatars 缓存,删卡时清掉。
   * in-flight 集合防重:缓存每次更新都会重跑这个 effect,不能让同一张被拉两遍。
   */
  const avatarInflight = useRef(new Set<string>());
  useEffect(() => {
    // 视觉小说的标题画面也要挑角色,开着它时同样要头像
    if (cardView !== 'list' && !vnOpen) return;
    for (const c of savedCards) {
      if (!c.has_avatar || cardAvatars.has(c.id) || avatarInflight.current.has(c.id)) continue;
      avatarInflight.current.add(c.id);
      debugApi
        .getCardAvatar(c.id)
        .then((dataUrl) => {
          if (!dataUrl) return;
          setCardAvatars((prev) => {
            if (prev.has(c.id)) return prev;
            const next = new Map(prev);
            next.set(c.id, dataUrl);
            return next;
          });
        })
        .catch(() => {
          // 拉不到就用默认头像兜底,不弹错 —— 列表是导航,不是告警通道
        })
        .finally(() => avatarInflight.current.delete(c.id));
    }
  }, [cardView, vnOpen, savedCards, cardAvatars]);

  // ---- 载入 ----

  /** 导入文件 = 解析 + 直接入库。PNG 的图本身留作头像;JSON 则看卡里带没带 */
  const loadCard = async (file: File) => {
    setCardBusy(true);
    setBusyLabel('正在导入角色卡……');
    try {
      const parsed = await parseCardFile(file);
      const isPng = file.name.toLowerCase().endsWith('.png') || file.type === 'image/png';
      const created = await debugApi.createCard({
        ...cardToStored(parsed),
        avatar: isPng ? await fileToDataUrl(file) : parsed.avatar,
      });
      const list = await debugApi.listCards();
      setSavedCards(list);
      await selectCard(created);
      notify('ok', `已导入角色卡「${parsed.name || file.name}」· ${parsed.spec}`);
    } catch (e) {
      notify('error', `角色卡导入失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCardBusy(false);
      setBusyLabel(null);
    }
  };

  // ---- 角色卡:自动保存 + CRUD ----

  /**
   * 改字段:立刻更新内存(输入框要跟手),然后 debounce 600ms 写库。
   * 和预设的显式保存不同 —— 卡的编辑是确定性的改动,不需要「试完丢弃」。
   */
  const changeCard = (patch: Partial<TavernCard>) => {
    if (!card) return;
    const next = { ...card, ...patch };
    setCard(next);
    if (!cardId) return;

    window.clearTimeout(cardSaveTimer.current);
    setCardSaveState('saving');
    cardSaveTimer.current = window.setTimeout(async () => {
      try {
        await debugApi.updateCard(cardId, cardToStored(next));
        setSavedCards(await debugApi.listCards());
        setCardSaveState('saved');
        window.clearTimeout(savedFlagTimer.current);
        savedFlagTimer.current = window.setTimeout(() => setCardSaveState('idle'), 1600);
      } catch (e) {
        setCardSaveState('idle');
        notify('error', `保存失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 600);
  };

  const newCard = async () => {
    setCardBusy(true);
    try {
      const created = await debugApi.createCard({ ...cardToStored(EMPTY_CARD), name: '新角色' });
      setSavedCards(await debugApi.listCards());
      await selectCard(created);
      notify('ok', '已新建角色卡');
    } catch (e) {
      notify('error', `新建失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCardBusy(false);
    }
  };

  const duplicateCard = async () => {
    if (!cardId) return;
    setCardBusy(true);
    try {
      const copy = await debugApi.duplicateCard(cardId);
      // 绑定跟着复制(立绘、语音后端复制时已经带上了)
      if (personaBindings.cards[cardId]) {
        changePersonaBindings(bindCard(personaBindings, copy.id, personaBindings.cards[cardId]));
      }
      if (presetBindings.cards[cardId]) {
        changePresetBindings(bindCard(presetBindings, copy.id, presetBindings.cards[cardId]));
      }
      setSavedCards(await debugApi.listCards());
      await selectCard(copy);
      notify('ok', `已复制为「${copy.name}」`);
    } catch (e) {
      notify('error', `复制失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCardBusy(false);
    }
  };

  const deleteCard = async () => {
    if (!cardId || !card) return;
    if (!window.confirm(`确定删除角色卡「${card.name || '(无名)'}」? 这个操作不可撤销。`)) return;
    setCardBusy(true);
    try {
      // 别让在途的自动保存把刚删的卡又写回去
      window.clearTimeout(cardSaveTimer.current);
      await debugApi.deleteCard(cardId);
      if (personaBindings.cards[cardId]) changePersonaBindings(bindCard(personaBindings, cardId, null));
      if (presetBindings.cards[cardId]) changePresetBindings(bindCard(presetBindings, cardId, null));
      // 列表缓存里的头像一起清
      setCardAvatars((prev) => {
        if (!prev.has(cardId)) return prev;
        const next = new Map(prev);
        next.delete(cardId);
        return next;
      });
      const list = await debugApi.listCards();
      setSavedCards(list);
      if (list[0]) {
        await selectCard(list[0]);
      } else {
        setCard(null);
        setCardId(null);
        setAvatarUrl(null);
        setEntries([]);
        // 对话留在库里(卡删了引用自动置空),只是界面上没地方挂它了
        setChats([]);
        setTreeChats([]);
        setChatId(null);
        persistedRef.current = { chatId: null, rows: new Map() };
      }
      notify('ok', '已删除');
    } catch (e) {
      notify('error', `删除失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCardBusy(false);
    }
  };

  /** 导出成 JSON。头像一起写进去 —— 不然导出再导入回来就成了无图卡 */
  const exportCard = async () => {
    if (!card) return;
    setBusyLabel('正在导出角色卡……');
    try {
      const avatar = avatarUrl ?? (cardId ? await debugApi.getCardAvatar(cardId) : null);
      const url = URL.createObjectURL(
        new Blob([cardToFileJson(card, avatar)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${card.name || 'character'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify('error', `导出失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyLabel(null);
    }
  };

  const changeAvatar = async (blob: Blob) => {
    if (!cardId) return;
    setCardBusy(true);
    try {
      const dataUrl = await fileToDataUrl(blob);
      await debugApi.updateCard(cardId, { avatar: dataUrl });
      setAvatarUrl(dataUrl);
      // 列表缓存同步换脸,不然列表里还是旧图
      setCardAvatars((prev) => {
        const next = new Map(prev);
        next.set(cardId, dataUrl);
        return next;
      });
      setSavedCards(await debugApi.listCards());
      notify('ok', '头像已更新');
    } catch (e) {
      notify('error', `头像更新失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCardBusy(false);
    }
  };

  /** 导入文件 = 解析 + 直接存进库,之后就出现在下拉里 */
  const loadPreset = async (file: File) => {
    setPresetBusy(true);
    setBusyLabel('正在导入预设……');
    try {
      const parsed = parsePreset(await file.text(), file.name.replace(/\.json$/i, ''));
      // -1 = 不替换任何编排组,原样入库(导入时还没有临时开关要合并)
      const created = await debugApi.createPreset(presetToStored(parsed, -1, []));
      await refreshPresets(created.id);
      // 后端对撞名的预设强制加了后缀,所以报名字要用它回给的,不是文件里的
      notify(
        'ok',
        `已导入预设「${created.name}」· ${parsed.prompts.length} 个块 / ${parsed.orderGroups.length} 组编排`,
      );
    } catch (e) {
      notify('error', `预设导入失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPresetBusy(false);
      setBusyLabel(null);
    }
  };

  // ---- 组装 ----

  const order: PresetOrderEntry[] = useMemo(() => {
    const group = preset?.orderGroups[groupIndex];
    if (!group) return [];
    return group.order.map((o) => ({
      ...o,
      enabled: overrides[o.identifier] ?? o.enabled,
    }));
  }, [preset, groupIndex, overrides]);

  // ---- 预设 CRUD ----

  const savePreset = async () => {
    if (!preset || !presetId) return;
    setPresetBusy(true);
    try {
      await debugApi.updatePreset(presetId, presetToStored(preset, groupIndex, order));
      const list = await debugApi.listPresets();
      setSavedPresets(list);
      // 开关已经写进 prompt_order 了,本地覆盖层可以清掉
      setOverrides({});
      setPresetDirty(false);
      notify('ok', `已保存预设「${preset.name}」`);
    } catch (e) {
      notify('error', `保存失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPresetBusy(false);
    }
  };

  const savePresetAs = async () => {
    if (!preset) return;
    const name = window.prompt('另存为新预设,取个名字:', `${preset.name} - 副本`);
    if (name === null) return;
    if (!name.trim()) {
      notify('error', '预设名不能为空');
      return;
    }
    setPresetBusy(true);
    try {
      const created = await debugApi.createPreset({
        ...presetToStored(preset, groupIndex, order),
        name: name.trim(),
      });
      await refreshPresets(created.id);
      notify('ok', `已另存为「${created.name}」`);
    } catch (e) {
      notify('error', `另存失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPresetBusy(false);
    }
  };

  /**
   * 新建预设:标准骨架(酒馆默认那 10 个块),直接入库并选中 ——
   * 和导入同一条路径。「从无到有」不靠它不行:⧉ 另存为只是复制当前,
   * 库里一个预设都没有时(或默认预设被删了)只有这条路能不靠导入起家。
   */
  const newPreset = async () => {
    // 建完会选中新预设 —— 等于切走,未保存的改动会丢,和下拉的守卫保持一致
    if (presetDirty && !window.confirm('当前预设有未保存的改动,新建会切走并丢弃。继续?')) return;
    const name = window.prompt('新建预设,取个名字:', '未命名预设');
    if (name === null) return;
    if (!name.trim()) {
      notify('error', '预设名不能为空');
      return;
    }
    setPresetBusy(true);
    try {
      // -1 = 不合并任何工作层,骨架原样入库(同导入)
      const created = await debugApi.createPreset(
        presetToStored(buildPresetSkeleton(name.trim()), -1, []),
      );
      await refreshPresets(created.id);
      notify('ok', `已新建预设「${created.name}」· 10 个标准块`);
    } catch (e) {
      notify('error', `新建失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPresetBusy(false);
    }
  };

  const renamePreset = async () => {
    if (!preset || !presetId) return;
    const name = window.prompt('重命名预设:', preset.name);
    if (name === null) return;
    if (!name.trim()) {
      notify('error', '预设名不能为空');
      return;
    }
    setPresetBusy(true);
    try {
      // 撞名的话后端会加后缀,界面得跟它对齐,不能拿用户输的那个名字
      const updated = await debugApi.updatePreset(presetId, { name: name.trim() });
      setPreset({ ...preset, name: updated.name });
      setSavedPresets(await debugApi.listPresets());
      notify('ok', `已重命名为「${updated.name}」`);
    } catch (e) {
      notify('error', `重命名失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPresetBusy(false);
    }
  };

  /** 丢弃未保存的改动,从库里重新拉一份 */
  const restorePreset = async () => {
    if (!presetId) return;
    setPresetBusy(true);
    try {
      const row = savedPresets.find((p) => p.id === presetId);
      if (row) {
        selectPreset(row);
        notify('ok', '已恢复到上次保存的状态');
      }
    } finally {
      setPresetBusy(false);
    }
  };

  const deletePreset = async () => {
    if (!presetId || !preset) return;
    if (!window.confirm(`确定删除预设「${preset.name}」? 这个操作不可撤销。`)) return;
    setPresetBusy(true);
    try {
      await debugApi.deletePreset(presetId);
      const cleaned = forgetPreset(presetBindings, presetId);
      if (JSON.stringify(cleaned) !== JSON.stringify(presetBindings)) changePresetBindings(cleaned);
      const list = await debugApi.listPresets();
      setSavedPresets(list);
      if (list[0]) {
        selectPreset(list[0]);
      } else {
        setPreset(null);
        setPresetId(null);
        setPresetDirty(false);
      }
      notify('ok', '已删除');
    } catch (e) {
      notify('error', `删除失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPresetBusy(false);
    }
  };

  const exportPreset = () => {
    if (!preset) return;
    const json = presetToFileJson(presetToStored(preset, groupIndex, order));
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${preset.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 改块的任意字段:只动内存,标脏,等用户点保存 */
  /** 编排里开关一块:只写覆盖层 + 标脏,点「存」才落库(和酒馆一样) */
  const toggleBlock = (identifier: string) => {
    setOverrides((prev) => {
      const current =
        prev[identifier] ??
        preset?.orderGroups[groupIndex]?.order.find((o) => o.identifier === identifier)?.enabled ??
        false;
      return { ...prev, [identifier]: !current };
    });
    setPresetDirty(true);
  };

  /** 插件块的 identifier:立绘、背景、音乐、外语、玩家台词各一块 */
  const blockIdOf = (kind: PluginKey) =>
    kind === 'sprite'
      ? SPRITE_BLOCK_ID
      : kind === 'lang'
        ? LANG_BLOCK_ID
        : kind === 'player'
          ? PLAYER_BLOCK_ID
          : SCENE[kind].blockId;

  /** 把插件块加进当前预设。和手动加块一样只动内存,点「存」才写回 */
  const insertPluginBlock = (kind: PluginKey) => {
    if (!preset) return;
    const identifier = blockIdOf(kind);
    setPreset(
      kind === 'sprite'
        ? insertSpriteBlock(preset, groupIndex, spriteConfig.blockPrompt)
        : kind === 'lang'
          ? insertLangBlock(preset, groupIndex, langConfig.blockPrompt)
          : kind === 'player'
            ? insertPlayerBlock(preset, groupIndex, playerConfig.blockPrompt)
            : insertSceneBlock(kind, preset, groupIndex, scenePlugin.configs[kind].blockPrompt),
    );
    // 块在库里、却在编排里被关着的情况,覆盖层里可能记着 false —— 加入就是要开
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[identifier];
      return next;
    });
    setPresetDirty(true);
  };

  /** 插件抽屉里「提示词块」那一组要的状态和操作 */
  const blockControls = (kind: PluginKey) => {
    const identifier = blockIdOf(kind);
    return {
      state:
        kind === 'sprite'
          ? spriteBlockState(preset, order)
          : kind === 'lang'
            ? langBlockState(preset, order)
            : kind === 'player'
              ? playerBlockState(preset, order)
              : sceneBlockState(kind, preset, order),
      onInsert: () => insertPluginBlock(kind),
      onToggle: () => toggleBlock(identifier),
      onRemove: () => deleteBlock(identifier),
    };
  };

  const updateBlock = (identifier: string, patch: Partial<PresetPrompt>) => {
    if (!preset) return;
    setPreset({
      ...preset,
      prompts: preset.prompts.map((p) => (p.identifier === identifier ? { ...p, ...patch } : p)),
    });
    setPresetDirty(true);
  };

  /**
   * 拖拽改编排顺序:同样只动内存,标脏。to = 移除源项之后的目标下标。
   *
   * order 是 useMemo 派生的、overrides 只存 enabled 覆写,装不下顺序,
   * 所以直接改 orderGroups。overrides 按 identifier 存,重排后自动跟着走。
   */
  const reorderBlock = (from: number, to: number) => {
    if (!preset || from === to) return;
    const group = preset.orderGroups[groupIndex];
    if (!group) return;
    const next = [...group.order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPreset({
      ...preset,
      orderGroups: preset.orderGroups.map((g, i) => (i === groupIndex ? { ...g, order: next } : g)),
    });
    setPresetDirty(true);
  };

  /**
   * 正被角色卡顶替的预设块。
   *
   * 覆盖一直开着(两处 assemble 调用点的 allowCardOverrides 都是 true),
   * 而且是静默发生的 —— 一张带 system_prompt 的卡会直接顶掉你的 main 块。
   * 调试台不该藏这个。
   */
  /**
   * 新建块:必须**同时**进块库和当前编排。
   *
   * 只进 prompts 的话它躺在库里永远不显示;只进 order 的话它是个悬空引用,
   * 组装时会被记成「块不存在于预设」。两处都写才是一个真正存在的块。
   *
   * 追加在编排末尾 —— 和左栏那颗「+」在列表底部的位置对得上,
   * 新块就出现在按钮原来待的地方,想挪再拖。
   *
   * 返回新块的 identifier,左栏拿它立刻把详情弹窗开起来:
   * 不然用户会得到一个没名字没内容的空块,还得自己去找它在哪。
   */
  const addBlock = (): string | null => {
    if (!preset) return null;
    const identifier = uuid();
    const prompt: PresetPrompt = {
      identifier,
      name: '新块',
      role: 'system',
      content: '',
      marker: false,
      // 用户自己建的,不是酒馆内置的那四个
      systemPrompt: false,
      injectionPosition: 0,
      injectionDepth: 4,
      forbidOverrides: false,
    };

    // 预设可能一组编排都没有(prompt_order 不是数组的畸形预设) —— 补一组,
    // 否则新块进了库却没地方放,等于白建
    const groups =
      preset.orderGroups.length > 0
        ? preset.orderGroups
        : [{ characterId: 100000, order: [] }];
    const targetIndex = groups[groupIndex] ? groupIndex : 0;

    setPreset({
      ...preset,
      prompts: [...preset.prompts, prompt],
      orderGroups: groups.map((g, i) =>
        i === targetIndex ? { ...g, order: [...g.order, { identifier, enabled: true }] } : g,
      ),
    });
    setPresetDirty(true);
    return identifier;
  };

  /**
   * 删块 —— 只允许删用户自建的块(非 marker、非内置),规则同酒馆:
   * 内置的那几个只能关不能删,关掉已经等于不发了。
   *
   * 要从**所有**编排组里清掉,不只当前这组 —— 预设可以按角色存多组编排,
   * 只清当前组的话,别的组里会留下一个指向已删块的悬空引用。
   */
  const deleteBlock = (identifier: string) => {
    if (!preset) return;
    setPreset({
      ...preset,
      prompts: preset.prompts.filter((p) => p.identifier !== identifier),
      orderGroups: preset.orderGroups.map((g) => ({
        ...g,
        order: g.order.filter((o) => o.identifier !== identifier),
      })),
    });
    setPresetDirty(true);
  };

  /**
   * marker 块的内容来源 —— 左栏点「⋯」看详情时用。
   *
   * 卡填的那几个(角色描述 / 性格 / 场景 / 示例对话)能在弹窗里直接改,
   * 确定后走 changeCard 写回卡;人设、聊天记录、世界书不在卡里,只指路。
   */
  const resolveMarker = useCallback(
    (identifier: string) => resolveMarkerSource(identifier, card, preset),
    [card, preset],
  );

  const overriddenIdentifiers = useMemo(() => {
    const s = new Set<string>();
    if (!card || !preset) return s;
    for (const p of preset.prompts) {
      if (p.marker || p.forbidOverrides) continue;
      if (p.identifier === 'main' && card.system_prompt.trim()) s.add('main');
      if (p.identifier === 'jailbreak' && card.post_history_instructions.trim()) {
        s.add('jailbreak');
      }
    }
    return s;
  }, [card, preset]);

  const history: ChatTurn[] = useMemo(
    () => entries.map((e) => ({ role: e.role, content: currentText(e) })),
    [entries],
  );

  /** 聊天区显示时展开宏用的取值。和组装提示词共用同一个构造函数,两边不会算出不同的 {{user}} */
  const displayMacros = useMemo(
    () =>
      buildMacroContext({
        card,
        userName,
        personaDescription: persona,
        history,
        custom: macroLookup,
      }),
    [card, userName, persona, history, macroLookup],
  );

  const activeConnection = connections.find((c) => c.id === connectionId) ?? null;

  /** 当前连接上次拉取并存库的模型列表 —— 顶栏模型下拉的选项就是它 */
  const cachedModels = activeConnection?.cached_models ?? [];
  const activeModel = activeConnection?.model ?? '';
  const modelInList = cachedModels.includes(activeModel);

  /**
   * 顶栏「模型」选中 = 改当前连接的 model 字段 —— 和 API 设置抽屉里的模型名是同一个
   * 值,两边都从 connections 渲染,所以改哪边另一边都跟着变。先乐观写本地,免得下拉回跳
   */
  const pickModel = (model: string) => {
    if (!connectionId || !model) return;
    setConnections((prev) => prev.map((c) => (c.id === connectionId ? { ...c, model } : c)));
    debugApi
      .updateConnection(connectionId, { model })
      .catch((e: unknown) =>
        notify('error', `切换模型失败: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(refreshConnections);
  };

  /** 现拉一次模型列表并写回连接(后端会存进 cached_models) */
  const refreshModelList = async () => {
    if (!connectionId) return;
    setModelsRefreshing(true);
    try {
      const list = await debugApi.refreshConnectionModels(connectionId);
      await refreshConnections();
      notify('ok', `拉到 ${list.length} 个模型`);
    } catch (e) {
      notify('error', `模型列表拉取失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setModelsRefreshing(false);
    }
  };
  // 流式与否是端点的属性,存在连接上;拿不到连接时默认试流式
  const useStreaming = activeConnection?.stream ?? true;

  /**
   * 滑动判定要读的状态。
   *
   * 不能直接用闭包里的 entries/tainted:连点两下时,第二下的处理器有可能来自
   * 还没提交的那次渲染,拿着旧的 swipeIndex 去判断「是不是最后一个分支」——
   * 判错的后果是本该循环的开场白真的去调了一次 API。ref 在每次提交后同步,
   * 读到的永远是最新的已提交状态。
   */
  const latest = useRef({ entries, tainted, sending });
  useEffect(() => {
    latest.current = { entries, tainted, sending };
  });

  /**
   * 逐操作写库:entries 每次提交后和水位线比引用/位置,变了的按 id upsert、
   * 消失的删除。patch() 只会替换目标条目的对象,所以引用比对就能精确圈出
   * 「哪个操作动了哪条消息」。流式中的目标条目跳过 —— 文字还在长,收尾那
   * 次提交(streaming 置 false)自然会把最终版写进去。
   */
  useEffect(() => {
    if (persistedRef.current.chatId !== chatId) {
      // 切了对话(或刚建):把当前状态认作水位线,不回写
      const rows = new Map<string, { entry: ChatEntry; idx: number }>();
      entries.forEach((e, i) => {
        if (!e.streaming) rows.set(e.id, { entry: e, idx: i });
      });
      persistedRef.current = { chatId, rows };
      return;
    }
    if (!chatId) return;

    const seen = new Set<string>();
    entries.forEach((entry, idx) => {
      seen.add(entry.id);
      if (entry.streaming) return;
      const prev = persistedRef.current.rows.get(entry.id);
      if (prev && prev.entry === entry && prev.idx === idx) return;
      debugApi
        .putChatMessage(chatId, toStored(entry, idx))
        .then(() => persistedRef.current.rows.set(entry.id, { entry, idx }))
        .catch((e: unknown) =>
          notify('error', `对话保存失败: ${e instanceof Error ? e.message : String(e)}`),
        );
    });
    for (const id of persistedRef.current.rows.keys()) {
      if (!seen.has(id)) {
        debugApi
          .deleteChatMessage(chatId, id)
          .then(() => persistedRef.current.rows.delete(id))
          .catch((e: unknown) =>
            notify('error', `对话保存失败: ${e instanceof Error ? e.message : String(e)}`),
          );
      }
    }
  }, [entries, chatId, notify]);

  // tainted 只在切换边沿写(loadChat/newChat 已把 ref 对齐成目标值)
  useEffect(() => {
    if (!chatId || taintedRef.current === tainted) return;
    taintedRef.current = tainted;
    debugApi.updateChat(chatId, { tainted }).catch((e: unknown) =>
      notify('error', `对话保存失败: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [chatId, tainted, notify]);

  // 卡/预设/用户名的绑定同步:防抖 600ms 只发改动的字段 —— user_name 在右栏
  // 是逐字输入的,不防抖会一次击键一个请求
  useEffect(() => {
    if (!chatId) return;
    const timer = window.setTimeout(() => {
      const patch: ChatPayload = {};
      // 切卡途中(见下面 card_id 那段):这时的预设是新卡绑定的、用户名是新卡人设的,
      // 都不属于还挂着的上一张对话,写进去的话再打开那张卡就恢复成别人的预设。
      // 等 loadChat/newChat 换好对话,chatId 一变这里会重算
      const switching = metaRef.current.card_id !== null && metaRef.current.card_id !== cardId;
      if (!switching && metaRef.current.preset_id !== presetId) patch.preset_id = presetId ?? null;
      // card_id 只在「收养孤儿对话」时写。孤儿 = 导入的 ST jsonl 按 character_name
      // 匹配不到卡(card_id 为空),在哪张卡上打开就归谁。
      //
      // 除此之外对话的归属只由 loadChat/newChat 决定,绝不跟着 cardId 走:切卡时
      // cardId 是同步变的,chatId 要等 listChats → getChat/createChat 两次往返才变,
      // 这中间的状态是「上一张对话 + 新卡」。照着它算 patch 就会把上一张卡的对话
      // 改判给新卡 —— 对话从原主人那儿消失,再切回去就打开了别人的历史。
      // 往返超过 600ms(手机网络下很常见)必现,本机偶发。
      if (metaRef.current.card_id === null && cardId) patch.card_id = cardId;
      if (!switching && metaRef.current.user_name !== userName) patch.user_name = userName;
      if (Object.keys(patch).length === 0) return;
      Object.assign(metaRef.current, patch);
      debugApi.updateChat(chatId, patch).catch((e: unknown) =>
        notify('error', `对话信息保存失败: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [chatId, presetId, cardId, userName, notify]);

  /** 下一次请求会发出去的东西 —— 输入框上方的统计就来自这里 */
  const preview = useMemo(() => {
    if (!card || !preset) return EMPTY_RESULT;
    return assemble({
      card,
      preset,
      order,
      history,
      userName,
      personaDescription: persona,
      customMacros: macroLookup,
      allowCardOverrides: true,
      tokenBudget: tokenBudget ?? null,
    });
  }, [card, preset, order, history, userName, persona, macroLookup, tokenBudget]);

  const ready = Boolean(card && preset && order.length > 0);

  /** 视觉小说「历史」页默认把这几类标签摘掉,只给人看正文 */
  const vnKinds = useMemo(
    () =>
      vnTagKinds(
        spriteConfig.tagTemplate,
        scenePlugin.configs.bg.tagTemplate,
        scenePlugin.configs.bgm.tagTemplate,
      ),
    [spriteConfig.tagTemplate, scenePlugin.configs],
  );

  // 预算/量程的写口:改了就持久化。手输的值超过当前量程时自动换到装得下的挡
  const changeBudget = (v: number | null) => {
    setTokenBudget(v);
    saveBudget(v);
    if (v !== null && v > rangeScale) setRangeScale(autoRange(v));
  };
  const changeRange = (r: number) => {
    setRangeScale(r);
    saveRange(r);
  };

  // ---- 发送 ----

  const buildSnapshot = (turns: ChatTurn[]) => {
    if (!card || !preset) return null;
    return assemble({
      card,
      preset,
      order,
      history: turns,
      userName,
      personaDescription: persona,
      customMacros: macroLookup,
      allowCardOverrides: true,
      tokenBudget: tokenBudget ?? null,
    });
  };

  /**
   * 把一次生成灌进某个条目的当前分支 —— 发送和右滑重生成共用这一段。
   * rollback 是失败时怎么撤销:发送要删掉整个空气泡,重生成只删掉新开的那个分支。
   */
  const runGeneration = async (
    targetId: string,
    snapshot: AssemblyResult,
    rollback: () => void,
  ) => {
    setError(null);
    setSending(true);
    let finish: () => void = () => {};
    inflightRef.current = new Promise<void>((resolve) => {
      finish = resolve;
    });

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const messages = snapshot.messages.map((m) => ({ role: m.role, content: m.content }));
    const model = activeConnection?.model || undefined;
    const startedAt = performance.now();
    const patch = (fn: (e: ChatEntry) => ChatEntry) =>
      setEntries((prev) => prev.map((e) => (e.id === targetId ? fn(e) : e)));

    // 累加在闭包里,setEntries 只负责渲染 —— 免得每帧都去读上一次的 state
    let body = '';

    try {
      if (useStreaming) {
        let reasoning = '';
        const done = await debugApi.streamComplete(
          messages,
          connectionId,
          model,
          controller.signal,
          {
            onMeta: (m) =>
              patch((e) =>
                patchSwipeInfo(e, {
                  connection: m.connection_name,
                  model: m.model,
                  ttftMs: m.ttft_ms,
                }),
              ),
            onReasoning: (t) => {
              reasoning += t;
              patch((e) => patchSwipeInfo(e, { reasoning }));
            },
            onDelta: (t) => {
              body += t;
              patch((e) => setSwipeText(e, body));
            },
          },
        );
        setLastRaw(body);
        patch((e) => ({
          ...patchSwipeInfo(e, {
            totalMs: done.total_ms,
            reasoningType: done.reasoning_type ?? undefined,
            reasoningMs: done.reasoning_ms ?? undefined,
          }),
          streaming: false,
        }));
      } else {
        const res = await debugApi.complete(messages, connectionId, model, controller.signal);
        body = res.raw;
        setLastRaw(res.raw);
        patch((e) => ({
          ...patchSwipeInfo(setSwipeText(e, res.raw), {
            connection: res.connection_name,
            model: res.model,
            totalMs: Math.round(performance.now() - startedAt),
          }),
          streaming: false,
        }));
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      // 已经吐出来的留着,一个字都没有的气泡才撤销 —— 不管是手动停止、网络断线,
      // 还是像"没收到结束帧"这种流被腰斩的情况:已经拿到手的内容不该因为收尾
      // 失败就跟着消失。真正的错误(非主动停止)额外弹一条页面顶部的提示。
      if (!aborted) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        notify('error', message);
      }
      patch((entry) => ({ ...entry, streaming: false }));
      if (!body.trim()) rollback();
    } finally {
      setSending(false);
      finish();
    }
  };

  const send = async (text: string) => {
    const snapshot = buildSnapshot([...history, { role: 'user' as const, content: text }]);
    if (!snapshot) return;

    // 空气泡先落地,文字直接长在真正的位置上,不用另做一个「请求中」的占位
    const pending = makePendingEntry(snapshot);
    setEntries((prev) => [...prev, makeUserEntry(text), pending]);
    setTainted(true);

    await runGeneration(pending.id, snapshot, () =>
      setEntries((prev) => prev.filter((e) => e.id !== pending.id)),
    );
  };

  /**
   * 视觉小说里的插话。玩家没读完最新那条回复就开口了:
   *   entryId + keep  → 那条回复截到 keep 为止(完整版留成另一个分支),再发玩家这句
   *   keep 为空串     → 一句都还没看到:这次生成整个撤掉(重来出的新分支只撤这一个)
   *   keep 为 null    → 不截,只是先停下正在写的那条
   * 正在生成时先停下,等那次收完尾(streaming 置 false、空回复撤销)再接着走。
   */
  const interject = async (text: string, entryId: string | null, keep: string | null) => {
    await stopGeneration();
    await sendAfter(latest.current.entries, text, entryId, keep);
  };

  /** 正在生成就先停下,等那次收完尾(streaming 置 false、空回复撤销) */
  const stopGeneration = async () => {
    if (!latest.current.sending) return;
    abortRef.current?.abort();
    await inflightRef.current;
    // 收尾的那几个 setState 要等提交后才进 latest —— 等它落定,最多等半秒
    for (let i = 0; i < 30 && latest.current.sending; i++) {
      await new Promise((r) => window.setTimeout(r, 16));
    }
  };

  /**
   * 视觉小说里翻回历史、在旧的位置开口:从那条回复分出一个新对话 —— 原来的对话一个字不动,
   * 就是一个存档,存档页里还能读回来。切到新对话,那条回复截到玩家读到的那句,再发玩家这句
   */
  const branchFromHistory = async (text: string, entryId: string, keep: string) => {
    if (!chatId || chatOp) return;
    await stopGeneration();
    const origin = chats.find((c) => c.id === chatId)?.name || '原来的对话';
    setChatOp('branch');
    let created;
    try {
      created = await debugApi.branchChat(chatId, entryId);
      setChats(await debugApi.listChats(cardId));
      refreshTree(cardId);
    } catch (e) {
      notify('error', `分支没建成: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      setChatOp(null);
    }
    const base = await loadChat(created.id);
    if (!base || base.length === 0) return;
    notify('ok', `已分出新的故事线「${created.name}」· 原来的进度留在存档「${origin}」`);
    // 分支复制出来的消息换了新 id:那条回复就是新对话的最后一条
    await sendAfter(base, text, base[base.length - 1].id, keep);
  };

  /** 在 base 这组条目后面发玩家这句;entryId / keep 怎么截见 interject */
  const sendAfter = async (
    from: ChatEntry[],
    text: string,
    entryId: string | null,
    keep: string | null,
  ) => {
    let base = from;
    const idx = entryId ? base.findIndex((e) => e.id === entryId) : -1;
    if (idx !== -1 && keep !== null) {
      const target = base[idx];
      const full = currentText(target);
      if (!keep.trim()) {
        base =
          target.swipes.length > 1
            ? base.map((e, i) => (i === idx ? dropSwipe(e, e.swipeIndex) : e))
            : base.filter((_, i) => i !== idx);
      } else if (keep !== full.trimEnd()) {
        base = base.map((e, i) => (i === idx ? addTruncatedSwipe(e, keep) : e));
      }
    } else if (idx !== -1 && !currentText(base[idx]).trim()) {
      // 停下时一个字都没写出来的空回复,收尾时已经撤掉了;这里防一手还没提交的情况
      base = base.filter((_, i) => i !== idx);
    }

    const snapshot = buildSnapshot([
      ...base.map((e) => ({ role: e.role, content: currentText(e) })),
      { role: 'user' as const, content: text },
    ]);
    if (!snapshot) return;
    const pending = makePendingEntry(snapshot);
    setEntries([...base, makeUserEntry(text), pending]);
    setTainted(true);
    await runGeneration(pending.id, snapshot, () =>
      setEntries((prev) => prev.filter((e) => e.id !== pending.id)),
    );
  };

  /** 右滑越过最后一个分支 —— 新开一个分支重新生成,旧的那次原样留着 */
  const regenerate = async (entry: ChatEntry) => {
    // 只有最后一条能滑,所以「这条之前的历史」就是去掉末尾
    const snapshot = buildSnapshot(
      latest.current.entries.slice(0, -1).map((e) => ({ role: e.role, content: currentText(e) })),
    );
    if (!snapshot) return;

    const at = entry.swipes.length; // 新分支的下标
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? appendSwipe(e, snapshot) : e)));
    setTainted(true);

    await runGeneration(entry.id, snapshot, () =>
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? dropSwipe(e, at) : e))),
    );
  };

  /**
   * 最后一条是用户发言时的「生成回复」—— 就是 send() 去掉「先追加一条用户消息」。
   *
   * 这个状态本身很常见:回复生成到一半断线、报错撤销了空气泡、或者手动删掉了
   * 不满意的回复。没有这条路的话对话就卡死在这儿 —— 用户既没法重新生成(没有
   * 可重跑的角色消息),又只能靠再发一条话把上一句顶掉。
   */
  const continueFromUser = async () => {
    const snapshot = buildSnapshot(
      // 不去尾:最后一条用户发言正是这次要回应的那句
      latest.current.entries.map((e) => ({ role: e.role, content: currentText(e) })),
    );
    if (!snapshot) return;

    const pending = makePendingEntry(snapshot);
    setEntries((prev) => [...prev, pending]);
    setTainted(true);

    await runGeneration(pending.id, snapshot, () =>
      setEntries((prev) => prev.filter((e) => e.id !== pending.id)),
    );
  };

  /**
   * 输入框上方那颗按钮。按最后一条是谁分两种活儿:
   *   角色消息 → 重跑它,结果追加成新分支(旧的左滑还能滑回去)
   *   用户发言 → 生成缺掉的那条回复
   *
   * 重跑走 regenerate() 而不是 swipe():后者对没改过的开场白是「在其他开场白
   * 之间循环」(不调 API),而这颗按钮要的是真生成。新对话里最后一条正好是
   * 开场白,于是「新对话直接重新生成第一条」自然成立。
   */
  const regenerateLast = () => {
    const now = latest.current;
    if (now.sending) return;
    const last = now.entries[now.entries.length - 1];
    if (!last) return;
    if (last.role === 'assistant') void regenerate(last);
    else void continueFromUser();
  };

  // ---- 编辑 / 删除 / 滑动 ----

  const editMessage = (id: string, text: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? setSwipeText(e, text) : e)));
    setTainted(true);
  };

  const deleteAt = (id: string, scope: 'message' | 'swipe') => {
    setEntries((prev) =>
      scope === 'message'
        ? prev.filter((e) => e.id !== id)
        : prev.map((e) => (e.id === id ? dropSwipe(e, e.swipeIndex) : e)),
    );
    setTainted(true);
  };

  const swipe = (id: string, dir: 'left' | 'right') => {
    const now = latest.current;
    if (now.sending) return; // 正在生成时不接受滑动

    const index = now.entries.findIndex((e) => e.id === id);
    const entry = now.entries[index];
    if (!entry) return;

    const behavior = overswipeOf(entry, index, now.entries.length, now.tainted);
    if (behavior === 'none') return; // 只有最后一条角色消息能滑,和酒馆一样

    const go = (to: number) =>
      setEntries((prev) => prev.map((e) => (e.id === id ? swipeTo(e, to) : e)));

    if (dir === 'left') {
      // 滑到头再往左会绕回最后一个,和酒馆一样
      go(entry.swipeIndex === 0 ? entry.swipes.length - 1 : entry.swipeIndex - 1);
      return;
    }

    if (entry.swipeIndex < entry.swipes.length - 1) {
      go(entry.swipeIndex + 1);
      return;
    }

    if (behavior === 'loop') {
      go(0);
    } else {
      void regenerate(entry);
    }
  };

  // ---- 三栏拖拽调宽 ----

  const startDrag = (side: 'left' | 'right', e: React.PointerEvent) => {
    // 移动端没有「列」可拖(两栏是全屏抽屉),分隔条本身也 display:none
    if (isMobile) return;
    if (side === 'left' ? leftCollapsed : rightCollapsed) return;
    e.preventDefault();
    draggingSide.current = side;
    const startX = e.clientX;
    const startW = side === 'left' ? leftW : rightW;
    let latest = startW;

    const onMove = (ev: PointerEvent) => {
      // 左栏往右拖变宽,右栏往左拖变宽
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      latest = clampPanel(startW + delta);
      (side === 'left' ? setLeftW : setRightW)(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('dragging-columns');
      draggingSide.current = null;
      window.localStorage.setItem(
        side === 'left' ? 'debug.leftW' : 'debug.rightW',
        String(Math.round(latest)),
      );
    };
    document.body.classList.add('dragging-columns');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 收起时不能写内联宽度变量 —— 内联样式会盖掉 .left-collapsed 类里的 44px
  const bodyStyle = {
    ...(leftCollapsed ? {} : { '--left': `${leftW}px` }),
    ...(rightCollapsed ? {} : { '--right': `${rightW}px` }),
  } as React.CSSProperties;

  /** 从库里挑一个预设换上。有没保存的改动时先问一句 —— 调试台左栏和视觉小说里共用 */
  const choosePreset = (id: string) => {
    const row = savedPresets.find((p) => p.id === id);
    if (!row) return;
    if (presetDirty && !window.confirm('当前预设有未保存的改动,切换会丢弃。继续?')) return;
    selectPreset(row);
  };

  /** 插件抽屉:调试台聊天区上一份,视觉小说菜单的插件页一份,只有打开到哪、怎么关不同 */
  const renderPluginsDrawer = (focus: PluginFocus | null, onClose: () => void) => (
    <PluginsDrawer
      presetName={preset?.name ?? null}
      presetDirty={presetDirty}
      presetBusy={presetBusy}
      onSavePreset={() => void savePreset()}
      card={cardId && card ? { id: cardId, name: card.name } : null}
      sprite={{
        config: spriteConfig,
        onChangeConfig: changeSpriteConfig,
        block: blockControls('sprite'),
        sprites,
        onSpritesChange: changeSprites,
        layout: spriteLayout,
      }}
      cards={savedCards.map((c) => ({ id: c.id, name: c.name }))}
      scene={scenePlugin}
      sceneBlocks={{ bg: blockControls('bg'), bgm: blockControls('bgm') }}
      sceneMacros={sceneMacroValues}
      voice={voicePlugin}
      lang={{ config: langConfig, onChangeConfig: changeLangConfig, block: blockControls('lang') }}
      player={{
        config: playerConfig,
        onChangeConfig: changePlayerConfig,
        block: blockControls('player'),
      }}
      focus={focus}
      notify={notify}
      onClose={onClose}
    />
  );

  /**
   * 预设面板:调试台左栏一份,视觉小说「调试」面板里一份,状态和操作是同一套,
   * 只有收起 / 点插件块这几处按所在位置不同
   */
  // ---- 角色卡的绑定:卡编辑器里的「绑定」一栏、预设面板的快捷勾选 ----

  const cardName = card?.name || '(无名)';
  const boundPresetId = presetForCard(
    presetBindings,
    cardId,
    savedPresets.map((p) => p.id),
  );
  const boundPersonaId = cardId ? (personaBindings.cards[cardId] ?? null) : null;

  /** 改这张卡绑的人设:存下来,当场换过去(解绑 = 换回默认人设,和选卡时一样) */
  const bindPersonaToCard = async (id: string | null) => {
    if (!cardId) return;
    const next = bindCard(personaBindings, cardId, id);
    changePersonaBindings(next);
    const name = personas.find((p) => p.id === id)?.name;
    const said = await applyBoundPersona(cardId, next);
    const head = name ? `「${cardName}」绑定了人设「${name}」` : `「${cardName}」不再绑定人设`;
    notify(said?.kind ?? 'ok', said ? `${head};${said.text}` : head);
  };

  /** 改这张卡绑的预设:存下来,绑上就当场换过去(有没保存的改动时先问);解绑不动当前预设 */
  const bindPresetToCard = (id: string | null) => {
    if (!cardId) return;
    changePresetBindings(bindCard(presetBindings, cardId, id));
    const name = savedPresets.find((p) => p.id === id)?.name;
    notify('ok', name ? `「${cardName}」绑定了预设「${name}」` : `「${cardName}」不再绑定预设`);
    if (id && id !== presetId) choosePreset(id);
  };

  const cardBindings = cardId ? (
    <CardBindings
      personas={personas}
      personaId={personas.some((p) => p.id === boundPersonaId) ? boundPersonaId : null}
      defaultPersonaName={personas.find((p) => p.id === personaBindings.default)?.name ?? null}
      presets={savedPresets}
      presetId={boundPresetId}
      busy={cardBusy}
      onPersona={(id) => void bindPersonaToCard(id)}
      onPreset={bindPresetToCard}
    />
  ) : null;

  const renderPresetPanel = (at: {
    collapsed: boolean;
    onToggleCollapse: () => void;
    onOpenPlugin: (identifier: string) => void;
  }) => (
    <PresetPanel
      preset={preset}
      order={order}
      activeGroupIndex={groupIndex}
      collapsed={at.collapsed}
      onToggleCollapse={at.onToggleCollapse}
      onPickGroup={(i) => {
        setGroupIndex(i);
        setOverrides({});
      }}
      onToggleBlock={toggleBlock}
      saved={savedPresets}
      selectedId={presetId}
      dirty={presetDirty}
      busy={presetBusy}
      onUpdateBlock={updateBlock}
      onReorder={reorderBlock}
      onAddBlock={addBlock}
      onDeleteBlock={deleteBlock}
      isPluginBlock={isPluginBlock}
      onOpenPlugin={at.onOpenPlugin}
      overridden={overriddenIdentifiers}
      resolveMarker={resolveMarker}
      macros={displayMacros}
      onUpdateCard={changeCard}
      onSelectPreset={choosePreset}
      onSave={savePreset}
      onSaveAs={savePresetAs}
      onNewPreset={newPreset}
      onRename={renamePreset}
      onRestore={restorePreset}
      onDelete={deletePreset}
      onImport={() => presetInputRef.current?.click()}
      onExport={exportPreset}
      cardBinding={
        cardId && presetId
          ? {
              cardName,
              boundName: savedPresets.find((p) => p.id === boundPresetId)?.name ?? null,
              bound: boundPresetId === presetId,
              onToggle: (on) => bindPresetToCard(on ? presetId : null),
            }
          : undefined
      }
    />
  );

  return (
    // vn-open:视觉小说盖在最上面时,从它里面打开的弹窗(块编辑、高级定义、看提示词)得压过它
    <div className={`console${vnOpen ? ' vn-open' : ''}`}>
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}

      {/* 导入/导出遮罩:比开机那层轻,只是挡住重复点击并说明在忙什么 */}
      {busyLabel && (
        <div className="op-veil">
          <div className="op-veil-card">
            <span className="spinner" />
            <span>{busyLabel}</span>
          </div>
        </div>
      )}

      {/* 开机遮罩:预设→卡→最近对话是串行的,盖住这段免得界面一格格长出来 */}
      {booting && (
        <div className="boot-veil">
          <div className="boot-mark">◆</div>
          <div className="boot-title">ANIMABACKEND</div>
          <div className="boot-line">
            <span className="spinner" /> 正在载入角色卡与预设……
          </div>
        </div>
      )}

      <div className="topbar">
        <div className="topbar-brand">
          <span className="topbar-title">
            <span className="topbar-title-wide">ANIMABACKEND</span>
            <span className="topbar-title-compact">ANIMA</span>
          </span>
          <span className="topbar-sub">PROMPT CONSOLE</span>
        </div>

        {/* 移动端专属:两侧面板的开关。桌面端靠列边缘那条竖排 panel-rail 收放,
            移动端根本没有「列」—— 两栏是盖住聊天区的全屏抽屉,得在顶栏给入口 */}
        <button
          className={`btn topbar-panel-btn${!leftCollapsed ? ' accent' : ''}`}
          onClick={() => {
            setMobileMenu(false);
            setLeftCollapsed((v) => !v);
            // 移动端两张抽屉都是全屏的,同时开只会互相盖住 —— 开一张就收掉另一张
            setRightCollapsed(true);
          }}
          title="预设面板"
          aria-label="预设面板"
        >
          <AnimaIcon name="preset" size={18} />
        </button>
        <button
          className={`btn topbar-panel-btn${!rightCollapsed ? ' accent' : ''}`}
          onClick={() => {
            setMobileMenu(false);
            setRightCollapsed((v) => !v);
            setLeftCollapsed(true);
          }}
          title="角色卡面板"
          aria-label="角色卡面板"
        >
          <AnimaIcon name="character-card" size={18} />
        </button>

        {/* 视觉小说入口:桌面和手机都在顶栏一级位置,不折进 ⋯ 菜单 */}
        <button
          className="btn icon-label topbar-vn-btn"
          onClick={() => toggleVn(true)}
          title="视觉小说模式 —— 用立绘和对话框看同一段对话"
          aria-label="视觉小说模式"
        >
          <AnimaIcon name="vn" size={17} />
          <span className="topbar-btn-label">视觉小说</span>
        </button>

        {/* 连接状态是「还能不能发消息」的唯一指示,移动端也留在顶栏,只是把文字收掉剩个点 */}
        <button
          className={`btn topbar-api-btn${drawer === 'api' ? ' active' : ''}`}
          onClick={() => toggleDrawer('api')}
          title="管理 API 连接"
        >
          {activeConnection ? <span className="dot on" /> : <span className="dot" />}
          <span className="topbar-btn-label">API 设置</span>
        </button>

        {/* 桌面端 display:none;移动端把 ⋯ 顶到最右 */}
        <div className="topbar-mobile-spacer" />

        {/* 桌面端:玩家、设置、连接和模型都是全局控制。
            移动端:前两项折进 ⋯；预设和角色卡本身有一级入口,导入动作留在各自面板。 */}
        <div className={`topbar-rest${mobileMenu ? ' open' : ''}`}>
          <input
            ref={cardInputRef}
            type="file"
            accept=".png,.json,image/png,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadCard(f);
              e.target.value = '';
            }}
          />

          {/* 玩家人设不常动,桌面保留文字入口;手机折进 ⋯ 菜单。 */}
          <button
            className={`btn icon-label topbar-action${drawer === 'persona' ? ' accent' : ''}`}
            onClick={() => toggleDrawer('persona')}
            title={`玩家人设 —— 决定提示词里 {{user}} 是谁${activePersona ? ` (当前:${activePersona.name})` : ''}`}
          >
            <AnimaIcon name="player" size={16} />
            <span>玩家</span>
          </button>
          {/* 显示偏好的总入口 —— 以后新增的设置都往这个抽屉里塞,不再往顶栏加按钮 */}
          <button
            className={`btn icon-label topbar-action${drawer === 'settings' ? ' accent' : ''}`}
            onClick={() => toggleDrawer('settings')}
            title="设置 —— 聊天区的排版、字号、对话高亮"
          >
            <AnimaIcon name="sliders" size={16} />
            <span>设置</span>
          </button>
          <button
            className={`btn icon-label topbar-action${drawer === 'plugins' ? ' accent' : ''}`}
            onClick={() => toggleDrawer('plugins')}
            title="插件 —— 立绘等视觉小说素材,以及它们的提示词块"
          >
            <AnimaIcon name="plugin" size={16} />
            <span>插件</span>
          </button>
          <input
            ref={presetInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadPreset(f);
              e.target.value = '';
            }}
          />

          <div className="topbar-spacer" />

          <div className="topbar-field">
            <span className="topbar-label">连接</span>
            <select
              className="select"
              value={connectionId ?? ''}
              onChange={(e) => selectConnection(e.target.value)}
              title="选中即切换为当前启用的连接 —— 和 API 设置里的选择互通"
            >
              {connections.length === 0 && <option value="">(无)</option>}
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.is_active ? ' ●' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="topbar-field">
            <span className="topbar-label">模型</span>
            {/* 选项只有当前连接上次从 API 拉到并存库的 cached_models;空列表时点 ⟳ 现拉一次 */}
            <select
              className="select topbar-model-select"
              value={modelInList ? activeModel : ''}
              title="当前连接用的模型 —— 和 API 设置里的模型名是同一个值,改哪边都同步"
              onChange={(e) => pickModel(e.target.value)}
            >
              {/* 连接的模型不在列表里(还没拉过/手打的)时占个位显示它,但不作为可选项 */}
              {!modelInList && (
                <option value="" disabled>
                  {activeModel || '未设模型'}
                  {activeModel && cachedModels.length > 0 ? '(不在列表中)' : ''}
                </option>
              )}
              {cachedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              className={`btn small${modelsRefreshing ? ' busy' : ''}`}
              disabled={!connectionId || modelsRefreshing}
              title={
                activeConnection?.cached_models_at
                  ? `重新拉取模型列表(上次 ${new Date(activeConnection.cached_models_at).toLocaleString()})`
                  : '拉取该连接的模型列表'
              }
              onClick={refreshModelList}
            >
              {modelsRefreshing ? '…' : <AnimaIcon name="refresh" size={15} />}
            </button>
          </div>
        </div>

        {/* 移动端菜单开关。菜单展开时点空白处收起 —— 背板见 .topbar-rest-veil */}
        <button
          className={`btn topbar-more-btn${mobileMenu ? ' accent' : ''}`}
          onClick={() => setMobileMenu((v) => !v)}
          title="更多"
          aria-label="更多"
          aria-expanded={mobileMenu}
        >
          <AnimaIcon name="more" size={18} />
        </button>
        {mobileMenu && (
          <div className="topbar-rest-veil" onClick={() => setMobileMenu(false)} />
        )}
      </div>

      <div
        className={`console-body ${leftCollapsed ? 'left-collapsed' : ''} ${
          rightCollapsed ? 'right-collapsed' : ''
        }`}
        style={bodyStyle}
      >
        <div className="left-col">
          {renderPresetPanel({
            collapsed: leftCollapsed,
            onToggleCollapse: () => setLeftCollapsed((v) => !v),
            onOpenPlugin: openPluginEditor,
          })}
          {!leftCollapsed && (
            <BudgetBar
              report={preview.budget}
              value={tokenBudget ?? null}
              onChange={changeBudget}
              range={rangeScale}
              onRange={changeRange}
            />
          )}
          {!leftCollapsed && (
            <div className="history-bar">
              <span className="chat-current" title="当前对话">
                {chats.find((c) => c.id === chatId) ? chatLabel(chats.find((c) => c.id === chatId)!) : '(无)'}
              </span>
              <button
                className={`history-trigger${showHistory ? ' open' : ''}`}
                onClick={() => {
                  const next = !showHistory;
                  setShowHistory(next);
                  // 入口在左栏,面板却画在聊天区里。移动端左栏是盖住聊天区的
                  // 全屏抽屉 —— 不顺手收掉它,点开历史看上去就是什么都没发生
                  if (next && isMobile) setLeftCollapsed(true);
                }}
                title="对话历史与分支 —— 在聊天区展开"
              >
                <AnimaIcon name="history" size={15} />
                <span>对话历史</span>
                {(treeLoading || chatOp === 'branch') && <span className="spinner tiny" />}
              </button>
            </div>
          )}
        </div>

        <div
          className={`col-resizer${leftCollapsed ? ' disabled' : ''}`}
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(e) => startDrag('left', e)}
        />

        <div className="chat-col">
          {drawer === 'settings' && (
            <SettingsDrawer
              settings={chatSettings}
              onChange={changeChatSettings}
              macros={displayMacros}
              custom={customMacros}
              onChangeCustom={changeCustomMacros}
              onClose={() => setDrawer(null)}
            />
          )}

          {drawer === 'plugins' && renderPluginsDrawer(pluginFocus, () => setDrawer(null))}

          {drawer === 'persona' && (
            <PersonaDrawer
              notify={notify}
              onClose={() => setDrawer(null)}
              onChanged={refreshPersonas}
              onPickAvatar={(id) => pickAvatarFor({ kind: 'persona', id })}
              bindings={personaBindings}
              onChangeBindings={changePersonaBindings}
              card={cardId && card ? { id: cardId, name: card.name } : null}
              cardNames={new Map(savedCards.map((c) => [c.id, c.name]))}
            />
          )}

          {drawer === 'api' && (
            <ConnectionsDrawer
              connections={connections}
              notify={notify}
              onClose={() => setDrawer(null)}
              onChanged={refreshConnections}
            />
          )}

          {showHistory && (
            <ChatHistoryOverlay
              chats={treeChats}
              currentChatId={chatId}
              noCharacter={!cardId}
              busy={treeLoading || chatOp === 'branch'}
              pending={chatOp}
              onSelect={(id) => {
                setShowHistory(false);
                void loadChat(id);
              }}
              onNewChat={() => {
                setShowHistory(false);
                void newChat();
              }}
              onImport={() => chatInputRef.current?.click()}
              onExport={() => void runExport(false)}
              onExportTree={() => void runExport(true)}
              onExportOne={(id) => runExport(false, id)}
              onRename={renameChat}
              onDelete={removeChat}
              onClose={() => setShowHistory(false)}
            />
          )}

          <ChatPanel
            entries={entries}
            settings={chatSettings}
            macros={displayMacros}
            chatKey={chatId}
            charName={card?.name ?? ''}
            userName={userName}
            userAvatar={avatarOf(activePersona)}
            charAvatar={avatarUrl}
            sending={sending}
            error={error}
            preview={preview}
            ready={ready}
            loading={chatLoading}
            version={version}
            activeConnection={activeConnection}
            cardCount={savedCards.length}
            onPickCharacter={() => {
              // 摊开右栏并切到角色列表 —— 移动端进来两栏是收起的,
              // 开始界面上这颗按钮就是唯一的入口
              setCardView('list');
              setRightCollapsed(false);
            }}
            onOpenConnections={() => setDrawer('api')}
            onSend={send}
            onInspect={setInspecting}
            onInspectSwipe={inspectSwipe}
            tainted={tainted}
            onStop={() => abortRef.current?.abort()}
            onEdit={editMessage}
            onDelete={deleteAt}
            onSwipe={swipe}
            onBranch={branchHere}
            onReset={() => void newChat()}
            onRegenerate={regenerateLast}
          />
        </div>

        <div
          className={`col-resizer${rightCollapsed ? ' disabled' : ''}`}
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(e) => startDrag('right', e)}
        />

        <CardPanel
          card={card}
          avatarUrl={avatarUrl}
          collapsed={rightCollapsed}
          saved={savedCards}
          selectedId={cardId}
          view={cardView}
          avatars={cardAvatars}
          saveState={cardSaveState}
          busy={cardBusy}
          onToggleCollapse={() => setRightCollapsed((v) => !v)}
          onToggleView={() => setCardView((v) => (v === 'list' ? 'editor' : 'list'))}
          onChange={changeCard}
          onSelectCard={(id) => {
            const row = savedCards.find((c) => c.id === id);
            if (row) selectCard(row);
          }}
          onNew={newCard}
          onDuplicate={duplicateCard}
          onDelete={deleteCard}
          onImport={() => cardInputRef.current?.click()}
          onExport={() => void exportCard()}
          onOpenAdvanced={() => setShowAdvanced(true)}
          onPickAvatar={() => avatarInputRef.current?.click()}
          bindings={cardBindings}
        />
      </div>

      {/* 头像选择:藏起来的 file input,点头像时触发 */}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setCropTask({ file: f, target: avatarTargetRef.current });
          e.target.value = '';
        }}
      />

      {/* 头像裁剪:卡图和人设头像同一个弹窗、同一套 2:3 规格 */}
      {cropTask && (
        <CropModal
          file={cropTask.file}
          onCancel={() => setCropTask(null)}
          onCropped={(blob) => {
            const { target } = cropTask;
            setCropTask(null);
            if (target.kind === 'card') void changeAvatar(blob);
            else void changePersonaAvatar(target.id, blob);
          }}
        />
      )}

      {/* 对话导入:藏起来的 file input,分支树里的 ↓ 触发,可多选 jsonl */}
      <input
        ref={chatInputRef}
        type="file"
        accept=".jsonl,application/jsonl,application/x-ndjson"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void importChats(files);
          e.target.value = '';
        }}
      />

      {showAdvanced && card && (
        <CardEditorDrawer
          card={card}
          preset={preset}
          order={order}
          result={preview}
          budget={tokenBudget ?? null}
          avatarUrl={avatarUrl}
          onChange={changeCard}
          onPickAvatar={() => avatarInputRef.current?.click()}
          onClose={() => setShowAdvanced(false)}
        />
      )}

      {vnOpen && (
        <VNScreen
          entries={entries}
          macros={displayMacros}
          charName={card?.name ?? ''}
          userName={userName}
          sprites={activeSprites}
          spriteStage={spriteLayout.stage}
          spriteLayout={spriteLayout.layout}
          tagTemplate={spriteConfig.tagTemplate}
          sceneAssets={activeSceneAssets}
          titleBgmId={scenePlugin.titleBgmId}
          onChangeTitleBgm={(id) => void scenePlugin.setTitleBgm(id)}
          bgTemplate={scenePlugin.configs.bg.tagTemplate}
          bgmTemplate={scenePlugin.configs.bgm.tagTemplate}
          voiceConfig={voicePlugin.config}
          voiceCast={voicePlugin.cast}
          onChangeVoiceConfig={voicePlugin.changeConfig}
          showJa={langConfig.showJa}
          enterKey={chatSettings.enterKey}
          onChangeEnterKey={(enterKey) => changeChatSettings({ ...chatSettings, enterKey })}
          sending={sending}
          canSend={ready && !chatLoading}
          notReadyHint={
            !card ? '先选一个角色' : !preset ? '先在菜单「预设」里选一个预设' : '准备中…'
          }
          chatKey={chatId}
          chatName={(() => {
            const c = chats.find((x) => x.id === chatId);
            return c ? chatLabel(c) : '';
          })()}
          chatUpdatedAt={chats.find((x) => x.id === chatId)?.updated_at ?? null}
          cardTag={card?.tags?.find((t) => t.trim())?.trim() ?? null}
          loading={chatLoading}
          modelLabel={activeModel}
          onSend={(text) => void send(text)}
          onInterject={(text, entryId, keep) => void interject(text, entryId, keep)}
          onBranch={(text, entryId, keep) => void branchFromHistory(text, entryId, keep)}
          onStop={() => abortRef.current?.abort()}
          onRegenerate={regenerateLast}
          onExit={() => toggleVn(false)}
          cards={savedCards.map((c) => ({
            id: c.id,
            name: c.name,
            avatar: cardAvatars.get(c.id) ?? null,
            hasLastChat: Boolean(c.last_chat_id),
          }))}
          currentCardId={cardId}
          onPickCard={(id, fresh) => {
            const row = savedCards.find((c) => c.id === id);
            if (row) void selectCard(row, { fresh });
          }}
          renderPage={(page, ctx) => {
            if (page === 'log') {
              return (
                <div className="vn-embed vn-log-embed">
                  <ChatPanel
                    variant="backlog"
                    // 默认只给人看正文:标签摘掉、宏展开;「显示原文」= 库里存的原样
                    displayText={ctx.raw ? (raw) => raw : (_raw, shown) => stripTags(shown, vnKinds)}
                    // 看正文时按画面上的句子列,要念的句子带重播 / 重新生成;看原文时照原样
                    renderBody={ctx.raw ? undefined : ctx.lineView}
                    onJump={ctx.jumpTo}
                    entries={entries}
                    settings={chatSettings}
                    macros={displayMacros}
                    chatKey={chatId}
                    charName={card?.name ?? ''}
                    userName={userName}
                    userAvatar={avatarOf(activePersona)}
                    charAvatar={avatarUrl}
                    sending={sending}
                    error={error}
                    preview={preview}
                    ready={ready}
                    loading={chatLoading}
                    version={version}
                    activeConnection={activeConnection}
                    cardCount={savedCards.length}
                    onPickCharacter={() => {}}
                    onOpenConnections={() => {}}
                    onSend={(text) => void send(text)}
                    onInspect={setInspecting}
                    onInspectSwipe={inspectSwipe}
                    tainted={tainted}
                    onStop={() => abortRef.current?.abort()}
                    onEdit={editMessage}
                    onDelete={deleteAt}
                    onSwipe={swipe}
                    onBranch={branchHere}
                    onReset={() => void newChat()}
                    onRegenerate={regenerateLast}
                  />
                </div>
              );
            }
            if (page === 'save') {
              return (
                <VNSaves
                  chats={chats}
                  currentChatId={chatId}
                  currentEntries={entries}
                  sceneAssets={activeSceneAssets}
                  sprites={activeSprites}
                  spriteStage={spriteLayout.stage}
                  spriteLayout={spriteLayout.layout}
                  tagKinds={vnKinds}
                  charName={card?.name ?? ''}
                  macros={displayMacros}
                  busy={chatOp !== null || chatLoading}
                  canSave={Boolean(chatId) && !sending && entries.length > 0}
                  onSaveHere={() => void saveBranch(ctx.currentMessageId)}
                  onLoad={(id) => {
                    ctx.close();
                    void loadChat(id);
                  }}
                  onNewStory={() => {
                    ctx.close();
                    void newChat();
                  }}
                  onRename={renameChat}
                  onDelete={removeChat}
                />
              );
            }
            if (page === 'card') {
              return (
                <div className="vn-embed vn-card-embed">
                  <CardPanel
                    card={card}
                    avatarUrl={avatarUrl}
                    collapsed={false}
                    saved={savedCards}
                    selectedId={cardId}
                    view={cardView}
                    avatars={cardAvatars}
                    saveState={cardSaveState}
                    busy={cardBusy}
                    onToggleCollapse={ctx.close}
                    onToggleView={() => setCardView((v) => (v === 'list' ? 'editor' : 'list'))}
                    onChange={changeCard}
                    onSelectCard={(id) => {
                      const row = savedCards.find((c) => c.id === id);
                      if (row) void selectCard(row);
                    }}
                    onNew={newCard}
                    onDuplicate={duplicateCard}
                    onDelete={deleteCard}
                    onImport={() => cardInputRef.current?.click()}
                    onExport={() => void exportCard()}
                    onOpenAdvanced={() => setShowAdvanced(true)}
                    onPickAvatar={() => avatarInputRef.current?.click()}
                    bindings={cardBindings}
                  />
                </div>
              );
            }
            if (page === 'plugin') {
              // 调试台的插件抽屉原样嵌进来:同一个组件、同一份数据,两边改动互通
              return (
                <div className="vn-embed vn-plugin-embed">
                  {renderPluginsDrawer(ctx.pluginFocus, ctx.close)}
                </div>
              );
            }
            if (page === 'preset') {
              return (
                <div className="vn-embed vn-preset-embed">
                  {renderPresetPanel({
                    collapsed: false,
                    onToggleCollapse: ctx.close,
                    // 插件块的正文在插件页里改:换到菜单的插件页,滚到那个插件的模板
                    onOpenPlugin: (identifier) => ctx.openPlugin(pluginOfBlock(identifier)),
                  })}
                </div>
              );
            }
            // 模型:就是调试台的「API 设置」,同一个组件、同一份连接数据,两边改动互通
            return (
              <div className="vn-embed vn-model-embed">
                <ConnectionsDrawer
                  connections={connections}
                  notify={notify}
                  onClose={ctx.close}
                  onChanged={refreshConnections}
                />
              </div>
            );
          }}
        />
      )}

      {inspecting && (
        <PromptInspector
          result={inspecting}
          lastRaw={lastRaw}
          onClose={() => setInspecting(null)}
          onNotify={notify}
        />
      )}
    </div>
  );
}
