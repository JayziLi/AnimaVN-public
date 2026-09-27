import { useEffect, useRef, useState } from 'react';
import {
  debugApi,
  sceneFileUrl,
  spriteImageUrl,
  type CardSprite,
  type EmotionStatus,
  type SceneKind,
} from '../lib/api';
import { enabledOnly, type BlockState, type PluginConfig } from '../plugins/common';
import type { LangPluginConfig } from '../plugins/lang';
import type { PlayerPluginConfig } from '../plugins/player';
import {
  SCENE,
  backgroundsOf,
  bgmsOf,
  sceneTagExample,
  validateSceneTemplate,
  type SceneKindKey,
} from '../plugins/scene';
import {
  DEFAULT_BLOCK_PROMPT,
  spriteMacros,
  tagExample,
  validateTemplate,
  type SpritePluginConfig,
} from '../plugins/sprite';
import type { ScenePluginState } from '../plugins/useScenePlugin';
import type { SpriteLayoutState } from '../plugins/useSpriteLayout';
import type { VoicePluginState } from '../plugins/useVoicePlugin';
import { bgmPlayer, useBgm } from '../vn/bgm';
import { CommitField, DeleteButton } from './pluginFields';
import { LangPanel } from './LangPanel';
import { PlayerPanel } from './PlayerPanel';
import { SpritePosition } from './SpritePosition';
import { errText, formatSize, useRunner } from './pluginRunner';
import { VoicePanel } from './VoicePanel';

/**
 * 插件抽屉 —— 左边是插件列表,右边是选中插件的配置。
 *
 * 每个插件都是同一个结构:提示词块(写进预设)、标签格式、提示词模板、素材表。
 * 立绘的素材按卡;背景和 BGM 的素材在场景包里,卡绑定一个包(两页共用顶上的
 * 场景包选择器)。语音的素材是语音服务那台机器上的模型和参考音频,这里只存路径,
 * 见 VoicePanel。
 */

/** 一个插件块在当前预设里的状态,以及对它的操作。块的正文就是插件的提示词模板,这里不管 */
export interface BlockControls {
  state: BlockState;
  onInsert: () => void;
  onToggle: () => void;
  /** 从当前预设里拿掉这一块 */
  onRemove: () => void;
}

/** 有提示词块的插件 */
export type PluginKey = 'sprite' | 'bg' | 'bgm' | 'lang' | 'player';
/** 抽屉左边列的插件;语音没有提示词块,所以不在 PluginKey 里 */
export type PluginSection = PluginKey | 'voice';
/** 打开到哪个插件;有提示词模板的滚到模板那儿。nonce 变了就再跳一次 */
export interface PluginFocus {
  section: PluginSection;
  nonce: number;
}

interface Props {
  presetName: string | null;
  presetDirty: boolean;
  presetBusy: boolean;
  onSavePreset: () => void;

  card: { id: string; name: string } | null;

  sprite: {
    config: SpritePluginConfig;
    onChangeConfig: (next: SpritePluginConfig) => void;
    block: BlockControls;
    sprites: CardSprite[];
    onSpritesChange: (cardId: string, next: CardSprite[]) => void;
    /** 立绘在游戏里怎么摆 */
    layout: SpriteLayoutState;
  };
  /** 全部角色卡,立绘位置预览里拿来对照 */
  cards: { id: string; name: string }[];

  scene: ScenePluginState;
  sceneBlocks: Record<SceneKindKey, BlockControls>;
  /** 插件宏的当前展开结果({{backgrounds}}、{{current_bg}} …),预览用 */
  sceneMacros: Record<string, string>;

  voice: VoicePluginState;

  /** 外语插件:日语配音、中文字幕 */
  lang: {
    config: LangPluginConfig;
    onChangeConfig: (next: LangPluginConfig) => void;
    block: BlockControls;
  };

  /** 玩家台词插件:模型替玩家写的台词弹成选项 */
  player: {
    config: PlayerPluginConfig;
    onChangeConfig: (next: PlayerPluginConfig) => void;
    block: BlockControls;
  };

  /** 从左栏点插件块跳过来:打开到这个插件,滚到提示词模板(语音没有模板,只切过去) */
  focus: PluginFocus | null;

  notify: (kind: 'ok' | 'error', message: string) => void;
  onClose: () => void;
}

const PLUGINS = [
  { key: 'sprite', name: '立绘', ready: true },
  { key: 'bg', name: '背景', ready: true },
  { key: 'bgm', name: 'BGM', ready: true },
  { key: 'voice', name: '语音', ready: true },
  { key: 'lang', name: '外语', ready: true },
  { key: 'player', name: '玩家台词', ready: true },
] as const;

/** 示例立绘:Ren'Py 官方示例游戏 The Question 里的 Sylvie(MIT 授权,见 public/vn/CREDITS.txt) */
const SAMPLE_SPRITES = [
  { file: 'sylvie-blue-normal.png', label: '平静', aliases: ['normal'], description: '平常的样子' },
  { file: 'sylvie-blue-smile.png', label: '微笑', aliases: ['smile'], description: '温和地笑，心情不错' },
  { file: 'sylvie-blue-giggle.png', label: '偷笑', aliases: ['giggle'], description: '忍不住笑出来，被逗乐或者有点害羞' },
  { file: 'sylvie-blue-surprised.png', label: '惊讶', aliases: ['surprised'], description: '吃惊、意外' },
];

/**
 * 示例场景包:背景来自 Ren'Py 示例游戏(MIT),音乐是 Kevin MacLeod 的曲子(CC BY 4.0),
 * 出处见 public/vn/CREDITS.txt
 */
const SAMPLE_PACK = {
  name: '示例 · 校园',
  description: '随仓库附带的免费授权素材,可以先用来试效果',
  bgms: [
    { file: 'bgm/carefree.mp3', label: '日常', aliases: ['daily'], description: '轻快的日常曲（Carefree）' },
    { file: 'bgm/wallpaper.mp3', label: '温馨', aliases: ['warm'], description: '温暖、放松（Wallpaper）' },
    { file: 'bgm/investigations.mp3', label: '紧张', aliases: ['tense'], description: '悬疑、紧张、有点不安（Investigations）' },
    { file: 'bgm/sad-trio.mp3', label: '伤感', aliases: ['sad'], description: '安静的伤感、回忆（Sad Trio）' },
  ],
  bgs: [
    { file: 'bg/uni.jpg', label: '校园', aliases: ['campus'], description: '大学校园的林荫道，白天', bgm: '日常', focus: 50 },
    { file: 'bg/lecturehall.jpg', label: '教室', aliases: ['classroom'], description: '阶梯教室', bgm: '日常', focus: 50 },
    { file: 'bg/club.jpg', label: '活动室', aliases: ['club'], description: '社团活动室，室内', bgm: '温馨', focus: 50 },
    { file: 'bg/meadow.jpg', label: '草地', aliases: ['meadow'], description: '郊外开阔的草地，安静', bgm: '温馨', focus: 50 },
  ],
};

/** 文件名 → 名字:去扩展名,去掉模板里会出问题的括号 */
function labelFromFile(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[\n\r<>[\]{}【】「」]/g, '')
    .trim()
    .slice(0, 40);
}

/** 从已占用的名字里挑一个不撞的:食堂、食堂2、食堂3… */
function uniqueLabel(base: string, fallback: string, taken: Set<string>) {
  const root = base || fallback;
  let name = root;
  let i = 2;
  while (taken.has(name.toLowerCase())) name = `${root}${i++}`;
  taken.add(name.toLowerCase());
  return name;
}

export function PluginsDrawer(props: Props) {
  const { focus } = props;
  const [section, setSection] = useState<PluginSection>(focus?.section ?? 'sprite');
  const { refreshPacks } = props.scene;

  // 左栏点了插件块:切到那个插件,把提示词模板滚进视野并闪一下,光标放进去
  useEffect(() => {
    if (!focus) return;
    setSection(focus.section);
    let clear: number | undefined;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`pl-prompt-${focus.section}`);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.classList.add('pl-flash');
      el.querySelector('textarea')?.focus({ preventScroll: true });
      clear = window.setTimeout(() => el.classList.remove('pl-flash'), 1600);
    }, 60);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(clear);
    };
  }, [focus]);

  // 场景包的数量、素材数这些在别处(别的设备)也可能变,进背景 / BGM 页时刷新一次
  useEffect(() => {
    if (section === 'bg' || section === 'bgm') void refreshPacks();
  }, [section, refreshPacks]);

  return (
    <div className="conn-drawer sp-drawer">
      <div className="conn-drawer-head">
        <span className="conn-drawer-title">插件 · PLUGINS</span>
        <span className="conn-drawer-sub">给视觉小说界面用的素材和提示词</span>
        <div style={{ flex: 1 }} />
        <button className="panel-collapse" onClick={props.onClose} title="关闭">
          ✕
        </button>
      </div>

      <div className="sp-main">
        <div className="sp-nav">
          {PLUGINS.map((p) => (
            <button
              key={p.key}
              className={`sp-nav-item${section === p.key ? ' active' : ''}`}
              disabled={!p.ready}
              onClick={() => setSection(p.key)}
              title={p.ready ? undefined : '还没做,之后接进来'}
            >
              <span>{p.name}</span>
              {!p.ready && <span className="pl-soon">即将推出</span>}
            </button>
          ))}
        </div>

        <div className="sp-body">
          {section === 'sprite' && <SpriteSection {...props} />}
          {(section === 'bg' || section === 'bgm') && (
            <SceneSection key={section} kind={section} {...props} />
          )}
          {section === 'voice' && (
            <VoicePanel
              voice={props.voice}
              card={props.card}
              sprites={enabledOnly(props.sprite.sprites)}
              notify={props.notify}
            />
          )}
          {section === 'lang' && (
            <LangPanel
              config={props.lang.config}
              onChangeConfig={props.lang.onChangeConfig}
              blockGroup={
                <BlockGroup
                  what="外语"
                  block={props.lang.block}
                  presetName={props.presetName}
                  presetDirty={props.presetDirty}
                  presetBusy={props.presetBusy}
                  onSavePreset={props.onSavePreset}
                />
              }
            />
          )}
          {section === 'player' && (
            <PlayerPanel
              config={props.player.config}
              onChangeConfig={props.player.onChangeConfig}
              blockGroup={
                <BlockGroup
                  what="玩家台词"
                  block={props.player.block}
                  presetName={props.presetName}
                  presetDirty={props.presetDirty}
                  presetBusy={props.presetBusy}
                  onSavePreset={props.onSavePreset}
                />
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── 三个插件共用的几块 ───────────────────────────

const BLOCK_STATE_TEXT: Record<BlockState, (what: string) => string> = {
  'no-preset': () => '还没有选预设',
  missing: (what) => `当前预设里还没有${what}块`,
  off: () => '已加入,但在编排里关着 —— 发送时不会带上',
  on: () => '已开启 —— 每次发送都会带上这块',
};

/** 「提示词块」一组:块在当前预设里的状态、加入 / 开关 / 移出、保存预设 */
function BlockGroup({
  what,
  block,
  presetName,
  presetDirty,
  presetBusy,
  onSavePreset,
}: {
  what: string;
  block: BlockControls;
  presetName: string | null;
  presetDirty: boolean;
  presetBusy: boolean;
  onSavePreset: () => void;
}) {
  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">提示词块</span>
        <span className="sp-group-note">
          作为一个新块加进预设,在左栏标着「插件」,可以开关、拖动位置;正文就是下面的提示词模板,
          所有预设共用这一份,不能在预设里单独改。预设里原有的块不会被改动。
        </span>
      </div>
      <div className={`pl-status ${block.state}`}>
        <span className="pl-status-dot" />
        <span className="pl-status-text">
          {presetName && <b>「{presetName}」</b>}
          {BLOCK_STATE_TEXT[block.state](what)}
        </span>
        {block.state === 'missing' && (
          <button className="btn small accent" onClick={block.onInsert}>
            加入当前预设
          </button>
        )}
        {(block.state === 'on' || block.state === 'off') && (
          <>
            <button className="btn small" onClick={block.onToggle}>
              {block.state === 'on' ? '关闭' : '开启'}
            </button>
            <DeleteButton disabled={false} label="移出预设" onConfirm={block.onRemove} />
          </>
        )}
      </div>
      {presetDirty && (
        <div className="pl-row">
          <span className="sp-group-note">预设有还没保存的修改,不保存的话刷新页面就没了。</span>
          <button className="btn small accent" disabled={presetBusy} onClick={onSavePreset}>
            保存预设
          </button>
        </div>
      )}
    </div>
  );
}

/** 「标签格式」+「提示词模板」两组 */
function ConfigGroups({
  anchor,
  config,
  onChangeConfig,
  validate,
  tagNote,
  sampleTag,
  defaultPrompt,
  promptNote,
  exampleMacro,
  example,
  previews,
}: {
  /** 提示词模板那一组的 id,左栏点插件块时滚到这里 */
  anchor: string;
  config: PluginConfig;
  onChangeConfig: (next: PluginConfig) => void;
  validate: (template: string) => string | null;
  tagNote: string;
  /** 模板 → AI 写出来的样子,比如 <sprite:微笑>「……」 */
  sampleTag: (template: string) => string;
  defaultPrompt: string;
  promptNote: React.ReactNode;
  /** {{sprite_tag}} 这类宏的名字和展开结果 */
  exampleMacro: string;
  example: string;
  /** 列表类宏的当前展开结果 */
  previews: { name: string; value: string }[];
}) {
  // 模板允许暂时是半成品(正在打字),合法了才往外交
  const [templateDraft, setTemplateDraft] = useState(config.tagTemplate);
  const templateError = validate(templateDraft);

  return (
    <>
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">标签格式</span>
          <span className="sp-group-note">{tagNote} 全局通用,手机和电脑同步。</span>
        </div>
        <input
          className="text-input pl-wide"
          value={templateDraft}
          spellCheck={false}
          onChange={(e) => {
            setTemplateDraft(e.target.value);
            if (validate(e.target.value) === null) {
              onChangeConfig({ ...config, tagTemplate: e.target.value });
            }
          }}
        />
        {templateError ? (
          <span className="pl-error">
            {templateError}(现在仍按「{config.tagTemplate}」识别)
          </span>
        ) : (
          <span className="sp-group-note">
            AI 会这样写:<code className="pl-code">{sampleTag(templateDraft)}</code>
          </span>
        )}
      </div>

      <div className="sp-group" id={anchor}>
        <div className="sp-group-head">
          <span className="sp-group-title">提示词模板</span>
          <span className="sp-group-note">{promptNote}</span>
        </div>
        <textarea
          className="text-input pl-wide pl-textarea"
          rows={9}
          value={config.blockPrompt}
          spellCheck={false}
          onChange={(e) => onChangeConfig({ ...config, blockPrompt: e.target.value })}
        />
        <div className="pl-row">
          <span className="sp-group-note">
            {`{{${exampleMacro}}}`} → <code className="pl-code">{example}</code>
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="btn small"
            disabled={config.blockPrompt === defaultPrompt}
            onClick={() => onChangeConfig({ ...config, blockPrompt: defaultPrompt })}
          >
            恢复默认模板
          </button>
        </div>
        {previews.map((p) => (
          <div key={p.name}>
            <div className="sp-group-note">{`{{${p.name}}}`} 现在展开为:</div>
            <pre className="pl-preview">{p.value}</pre>
          </div>
        ))}
      </div>
    </>
  );
}

// ─────────────────────────── 立绘 ───────────────────────────

/** 情绪识别模型装没装:对不上立绘名的标签靠它挑最像的 */
function EmotionModelStatus() {
  const [status, setStatus] = useState<EmotionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    debugApi
      .emotionStatus()
      .then((s) => alive && setStatus(s))
      .catch((e: unknown) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">情绪识别</span>
        <span className="sp-group-note">AI 写的表情对不上立绘名时,用模型挑列表里最像的一张。</span>
      </div>
      {error ? (
        <span className="pl-error">查不到模型状态:{error}</span>
      ) : !status ? (
        <span className="sp-group-note">检查中…</span>
      ) : status.ready ? (
        <span className="sp-group-note">模型已就绪({status.model})</span>
      ) : (
        <span className="pl-error">
          {status.detail}。在 AnimaBackend 里运行{' '}
          <code className="pl-code">python scripts/download_emotion_model.py</code>
          。不装也能用,只是对不上列表的表情不会切图。
        </span>
      )}
    </div>
  );
}

function SpriteSection({
  sprite,
  scene,
  cards,
  presetName,
  presetDirty,
  presetBusy,
  onSavePreset,
  card,
  notify,
}: Props) {
  const { config, onChangeConfig, block, sprites, onSpritesChange } = sprite;
  const macros = spriteMacros(config, enabledOnly(sprites));

  return (
    <>
      <BlockGroup
        what="立绘"
        block={block}
        presetName={presetName}
        presetDirty={presetDirty}
        presetBusy={presetBusy}
        onSavePreset={onSavePreset}
      />
      <ConfigGroups
        anchor="pl-prompt-sprite"
        config={config}
        onChangeConfig={onChangeConfig}
        validate={validateTemplate}
        tagNote="AI 用这个格式标出表情,视觉小说界面也按它来识别。{表情} 的位置写表情名。"
        sampleTag={(t) => `${t.replace('{表情}', sprites[0]?.label ?? '微笑')}「……」`}
        defaultPrompt={DEFAULT_BLOCK_PROMPT}
        promptNote={
          <>
            「立绘指令 · 插件」块的正文,所有预设共用,改完立即生效。{'{{sprites}}'} 会展开成当前角色卡的表情列表
            (没配立绘时是内置基础表情),{'{{sprite_tag}}'} 展开成标签示例,{'{{sprite_examples}}'} 展开成正误示范。
          </>
        }
        exampleMacro="sprite_tag"
        example={tagExample(config.tagTemplate)}
        previews={[
          { name: 'sprites', value: macros.sprites },
          { name: 'sprite_examples', value: macros.sprite_examples },
        ]}
      />

      <EmotionModelStatus />

      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">位置{card ? ` · ${card.name || '(未命名)'}` : ''}</span>
          <span className="sp-group-note">
            所有角色按脸对齐:脸一样大、头在同一高度,换角色、换表情时人不会忽大忽小。上传立绘时自动找脸;
            不满意可以在画面上拖动、放大缩小,或者调所有角色共用的人物大小和头的高度。
          </span>
        </div>
        {card ? (
          <SpritePosition
            key={card.id}
            card={card}
            sprites={sprites}
            sceneAssets={scene.assets}
            cards={cards}
            state={sprite.layout}
          />
        ) : (
          <div className="sp-empty">先在右栏选一张角色卡。</div>
        )}
      </div>

      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">
            表情映射{card ? ` · ${card.name || '(未命名)'}` : ''}
          </span>
          <span className="sp-group-note">
            每张卡一套。AI 写的表情名(或别名)对上哪一行,就换成那一行的图;对不上的由情绪识别模型挑最像的一行。排第一的是默认表情。
            不想用的点「禁用」:游戏里当它不存在,图和名字都留着,随时能再启用。
          </span>
        </div>
        {card ? (
          <SpriteTable
            key={card.id}
            cardId={card.id}
            sprites={sprites}
            onSpritesChange={onSpritesChange}
            notify={notify}
          />
        ) : (
          <div className="sp-empty">先在右栏选一张角色卡。</div>
        )}
      </div>
    </>
  );
}

function SpriteTable({
  cardId,
  sprites,
  onSpritesChange,
  notify,
}: {
  cardId: string;
  sprites: CardSprite[];
  onSpritesChange: (cardId: string, next: CardSprite[]) => void;
  notify: Props['notify'];
}) {
  const batchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const [busy, run] = useRunner(notify, async () =>
    onSpritesChange(cardId, await debugApi.listSprites(cardId)),
  );

  /** 所有已被占用的名字(小写),新建时避开 */
  const takenNames = () =>
    new Set(sprites.flatMap((s) => [s.label, ...s.aliases]).map((n) => n.toLowerCase()));

  const addEmpty = () =>
    run('新建', async () => {
      await debugApi.createSprite(cardId, { label: uniqueLabel('新表情', '表情', takenNames()) });
    });

  const batchUpload = (files: File[]) =>
    run(`上传 ${files.length} 张`, async () => {
      const taken = takenNames();
      for (const f of files) {
        const created = await debugApi.createSprite(cardId, {
          label: uniqueLabel(labelFromFile(f.name), '表情', taken),
        });
        await debugApi.uploadSpriteImage(cardId, created.id, f);
      }
      notify('ok', `已添加 ${files.length} 个表情,记得把名字改成 AI 好理解的词`);
    });

  const loadSamples = () =>
    run('载入示例', async () => {
      const taken = takenNames();
      let added = 0;
      for (const s of SAMPLE_SPRITES) {
        if (taken.has(s.label.toLowerCase())) continue;
        const res = await fetch(`/vn/sample-sprites/${s.file}`);
        if (!res.ok) throw new Error(`示例图 ${s.file} 下载失败`);
        const created = await debugApi.createSprite(cardId, {
          label: s.label,
          aliases: s.aliases.filter((a) => !taken.has(a.toLowerCase())),
          description: s.description,
        });
        await debugApi.uploadSpriteImage(cardId, created.id, await res.blob());
        added++;
      }
      notify('ok', added ? `已载入 ${added} 个示例表情` : '示例表情都已经在列表里了');
    });

  const update = (spriteId: string, patch: { label?: string; aliases?: string[]; description?: string }) =>
    run('保存', async () => {
      await debugApi.updateSprite(cardId, spriteId, patch);
    });

  const setEnabled = (spriteId: string, enabled: boolean) =>
    run(enabled ? '启用' : '禁用', async () => {
      await debugApi.updateSprite(cardId, spriteId, { enabled });
    });

  /** 默认表情 = 排在最前面的、没禁用的那张 */
  const defaultId = sprites.find((s) => s.enabled)?.id ?? null;

  return (
    <div className="pl-sprites">
      <div className="pl-row">
        <button className="btn small" disabled={!!busy} onClick={addEmpty}>
          + 添加表情
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => batchRef.current?.click()}>
          批量上传图片
        </button>
        <button
          className="btn small"
          disabled={!!busy}
          onClick={loadSamples}
          title="Ren'Py 示例游戏里的角色 Sylvie,四个表情,可以先用来试效果"
        >
          载入示例立绘
        </button>
        {busy && (
          <span className="sp-group-note">
            <span className="spinner tiny" /> {busy}…
          </span>
        )}
      </div>

      <input
        ref={batchRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void batchUpload(files);
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          const target = replaceTarget.current;
          e.target.value = '';
          if (f && target) {
            void run('换图', async () => {
              await debugApi.uploadSpriteImage(cardId, target, f);
            });
          }
        }}
      />

      {sprites.length === 0 ? (
        <div className="sp-empty">
          还没有表情。批量上传时文件名就是表情名(比如 微笑.png);没有素材的话先载入示例立绘试试。
        </div>
      ) : (
        <div className="pl-sprite-list">
          {sprites.map((s) => {
            const url = spriteImageUrl(s);
            return (
              <div key={s.id} className={`pl-sprite${s.enabled ? '' : ' off'}`}>
                <button
                  className="pl-thumb"
                  title={url ? '点击换图' : '点击上传图片'}
                  disabled={!!busy}
                  onClick={() => {
                    replaceTarget.current = s.id;
                    replaceRef.current?.click();
                  }}
                >
                  {url ? <img src={url} alt={s.label} /> : <span>上传</span>}
                </button>
                <LabelFields
                  noun="表情名"
                  item={s}
                  isDefault={s.id === defaultId}
                  descPlaceholder="给 AI 看的:什么时候用这个表情"
                  onCommit={(patch) => update(s.id, patch)}
                />
                <div className="pl-actions">
                  <EnableButton
                    enabled={s.enabled}
                    disabled={!!busy}
                    onChange={(on) => void setEnabled(s.id, on)}
                  />
                  <button
                    className="btn small"
                    disabled={s.id === defaultId || !s.enabled || !!busy}
                    onClick={() =>
                      void run('排序', async () => {
                        await debugApi.reorderSprites(cardId, [
                          s.id,
                          ...sprites.map((x) => x.id).filter((id) => id !== s.id),
                        ]);
                      })
                    }
                    title="挪到第一个 —— 回复里还没写标签时用它"
                  >
                    设为默认
                  </button>
                  <DeleteButton
                    disabled={!!busy}
                    onConfirm={() =>
                      void run('删除', async () => {
                        await debugApi.deleteSprite(cardId, s.id);
                      })
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 禁用 / 启用:禁用的素材游戏里当作不存在,但留着,不用删 */
function EnableButton({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      className={`btn small${enabled ? '' : ' accent'}`}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      title={enabled ? '游戏里不再用它,素材留着,随时能再启用' : '重新在游戏里用它'}
    >
      {enabled ? '禁用' : '启用'}
    </button>
  );
}

/** 名字 / 别名 / 说明三格,立绘和场景素材共用 */
function LabelFields({
  noun,
  item,
  isDefault,
  descPlaceholder,
  onCommit,
  children,
}: {
  noun: string;
  item: { label: string; aliases: string[]; description: string; enabled: boolean };
  isDefault: boolean;
  descPlaceholder: string;
  onCommit: (patch: { label?: string; aliases?: string[]; description?: string }) => Promise<boolean>;
  children?: React.ReactNode;
}) {
  return (
    <div className="pl-fields">
      <div className="pl-field-row">
        <CommitField label={noun} value={item.label} onCommit={(v) => onCommit({ label: v })} />
        {!item.enabled ? (
          <span className="pl-badge off" title="游戏里不用它">
            已禁用
          </span>
        ) : (
          isDefault && <span className="pl-badge">默认</span>
        )}
      </div>
      <CommitField
        label="别名"
        placeholder="用逗号分隔,比如 smile, 笑"
        value={item.aliases.join(', ')}
        onCommit={(v) =>
          onCommit({
            aliases: v
              .split(/[,，]/)
              .map((a) => a.trim())
              .filter(Boolean),
          })
        }
      />
      <CommitField
        label="说明"
        placeholder={descPlaceholder}
        value={item.description}
        onCommit={(v) => onCommit({ description: v })}
      />
      {children}
    </div>
  );
}

// ─────────────────────────── 背景 / BGM ───────────────────────────

const SCENE_TEXT: Record<
  SceneKindKey,
  { what: string; tagNote: string; sample: string; macros: [string, string]; exampleMacro: string }
> = {
  bg: {
    what: '场景',
    tagNote: 'AI 换场景时用这个格式,视觉小说界面按它换背景。{场景} 的位置写场景名。',
    sample: '食堂',
    macros: ['backgrounds', 'current_bg'],
    exampleMacro: 'bg_tag',
  },
  bgm: {
    what: '音乐',
    tagNote: 'AI 在气氛转变时用这个格式换曲子。{音乐} 的位置写音乐名。',
    sample: '紧张',
    macros: ['bgms', 'current_bgm'],
    exampleMacro: 'bgm_tag',
  },
};

function SceneSection({
  kind,
  scene,
  sceneBlocks,
  sceneMacros,
  presetName,
  presetDirty,
  presetBusy,
  onSavePreset,
  card,
  notify,
}: Props & { kind: SceneKindKey }) {
  const text = SCENE_TEXT[kind];
  const config = scene.configs[kind];
  const [listMacro, currentMacro] = text.macros;
  const pack = scene.packs.find((p) => p.id === scene.packId) ?? null;

  return (
    <>
      <PackBar card={card} scene={scene} notify={notify} />

      <BlockGroup
        what={text.what}
        block={sceneBlocks[kind]}
        presetName={presetName}
        presetDirty={presetDirty}
        presetBusy={presetBusy}
        onSavePreset={onSavePreset}
      />
      <ConfigGroups
        anchor={`pl-prompt-${kind}`}
        config={config}
        onChangeConfig={(next) => scene.changeConfig(kind, next)}
        validate={(t) => validateSceneTemplate(kind, t)}
        tagNote={text.tagNote}
        sampleTag={(t) => t.replace(SCENE[kind].placeholder, text.sample)}
        defaultPrompt={SCENE[kind].defaults.blockPrompt}
        promptNote={
          <>
            「{SCENE[kind].blockName}」块的正文,所有预设共用,改完立即生效。{`{{${listMacro}}}`} 展开成场景包里的{text.what}列表,
            {`{{${currentMacro}}}`} 展开成对话进行到现在的{text.what}。
          </>
        }
        exampleMacro={text.exampleMacro}
        example={sceneTagExample(kind, config.tagTemplate)}
        previews={[
          { name: listMacro, value: sceneMacros[listMacro] ?? '' },
          { name: currentMacro, value: sceneMacros[currentMacro] ?? '' },
        ]}
      />

      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">
            {kind === 'bg' ? '背景' : '音乐'}
            {pack ? ` · ${pack.name}` : ''}
          </span>
          <span className="sp-group-note">
            {kind === 'bg'
              ? '排第一的是默认场景。每个场景可以指定一首默认音乐:换到这个场景时自动换上。'
              : '按气氛起名(日常、温馨、紧张、伤感…),AI 看名字和说明挑曲子;真正的曲名写在说明里。'}
            不想用的点「禁用」:游戏里当它不存在,文件留在包里,随时能再启用。
            {pack && pack.card_count > 1 && `这个包有 ${pack.card_count} 张卡在用,禁用对它们都生效。`}
          </span>
        </div>
        {!card ? (
          <div className="sp-empty">先在右栏选一张角色卡。</div>
        ) : !scene.packId ? (
          <div className="sp-empty">这张卡还没有绑定场景包。在上面选一个,或者新建一个。</div>
        ) : kind === 'bg' ? (
          <BgTable key={scene.packId} packId={scene.packId} scene={scene} notify={notify} />
        ) : (
          <BgmTable key={scene.packId} packId={scene.packId} scene={scene} notify={notify} />
        )}
      </div>
    </>
  );
}

/** 场景包选择器:这张卡用哪个包,以及新建 / 重命名 / 删除 / 载入示例 */
function PackBar({
  card,
  scene,
  notify,
}: {
  card: Props['card'];
  scene: ScenePluginState;
  notify: Props['notify'];
}) {
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const pack = scene.packs.find((p) => p.id === scene.packId) ?? null;

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      notify('error', errText(e));
    } finally {
      setBusy(null);
      await scene.refreshPacks();
    }
  };

  const submitName = () => {
    const name = draft.trim();
    if (!name) return;
    const mode = naming;
    setNaming(null);
    void act(mode === 'new' ? '新建' : '重命名', async () => {
      if (mode === 'new') {
        const created = await debugApi.createScenePack(name);
        if (card) await scene.bindPack(created.id);
      } else if (pack) {
        await debugApi.updateScenePack(pack.id, { name });
      }
    });
  };

  const loadSample = () =>
    act('载入示例', async () => {
      const existing = scene.packs.find((p) => p.name === SAMPLE_PACK.name);
      if (existing) {
        await scene.bindPack(existing.id);
        notify('ok', `「${SAMPLE_PACK.name}」已经有了,已绑定到这张卡`);
        return;
      }
      const created = await debugApi.createScenePack(SAMPLE_PACK.name, SAMPLE_PACK.description);
      const bgmIds = new Map<string, string>();
      for (const m of SAMPLE_PACK.bgms) {
        const res = await fetch(`/vn/${m.file}`);
        if (!res.ok) throw new Error(`示例音乐 ${m.file} 下载失败`);
        const a = await debugApi.createSceneAsset(created.id, {
          kind: 'bgm',
          label: m.label,
          aliases: m.aliases,
          description: m.description,
        });
        await debugApi.uploadSceneFile(created.id, a.id, await res.blob());
        bgmIds.set(m.label, a.id);
      }
      for (const b of SAMPLE_PACK.bgs) {
        const res = await fetch(`/vn/${b.file}`);
        if (!res.ok) throw new Error(`示例背景 ${b.file} 下载失败`);
        const a = await debugApi.createSceneAsset(created.id, {
          kind: 'bg',
          label: b.label,
          aliases: b.aliases,
          description: b.description,
        });
        await debugApi.uploadSceneFile(created.id, a.id, await res.blob());
        await debugApi.updateSceneAsset(created.id, a.id, {
          bgm_id: bgmIds.get(b.bgm) ?? null,
          focus_x: b.focus,
        });
      }
      if (card) await scene.bindPack(created.id);
      notify('ok', `已载入示例场景包:${SAMPLE_PACK.bgs.length} 个场景、${SAMPLE_PACK.bgms.length} 首音乐`);
    });

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">场景包{card ? ` · ${card.name || '(未命名)'}` : ''}</span>
        <span className="sp-group-note">
          一组背景 + 音乐。每张卡绑一个包,同一个世界观的几张卡可以绑同一个;背景和 BGM 两页共用。
        </span>
      </div>
      {!card ? (
        <div className="sp-empty">先在右栏选一张角色卡。</div>
      ) : (
        <>
          <div className="pl-row">
            <select
              className="text-input pl-pack-select"
              value={scene.packId ?? ''}
              disabled={!!busy}
              onChange={(e) => void act('绑定', () => scene.bindPack(e.target.value || null))}
            >
              <option value="">不使用场景包</option>
              {scene.packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}({p.bg_count} 个场景 · {p.bgm_count} 首音乐)
                </option>
              ))}
            </select>
            {busy && (
              <span className="sp-group-note">
                <span className="spinner tiny" /> {busy}…
              </span>
            )}
          </div>
          {naming ? (
            <div className="pl-row">
              <input
                className="text-input pl-pack-name"
                value={draft}
                autoFocus
                placeholder="场景包名字,比如 罗德岛"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitName();
                  if (e.key === 'Escape') setNaming(null);
                }}
              />
              <button className="btn small accent" disabled={!draft.trim()} onClick={submitName}>
                {naming === 'new' ? '新建并绑定' : '改名'}
              </button>
              <button className="btn small" onClick={() => setNaming(null)}>
                取消
              </button>
            </div>
          ) : (
            <div className="pl-row">
              <button
                className="btn small"
                disabled={!!busy}
                onClick={() => {
                  setDraft('');
                  setNaming('new');
                }}
              >
                + 新建场景包
              </button>
              {pack && (
                <button
                  className="btn small"
                  disabled={!!busy}
                  onClick={() => {
                    setDraft(pack.name);
                    setNaming('rename');
                  }}
                >
                  重命名
                </button>
              )}
              <button
                className="btn small"
                disabled={!!busy}
                onClick={() => void loadSample()}
                title="随仓库附带的免费授权背景和音乐,可以先用来试效果"
              >
                载入示例场景包
              </button>
              {pack && (
                <DeleteButton
                  disabled={!!busy}
                  label="删除这个包"
                  onConfirm={() =>
                    void act('删除', async () => {
                      await debugApi.deleteScenePack(pack.id);
                      scene.forgetPack(pack.id);
                      notify(
                        'ok',
                        pack.card_count > 1
                          ? `已删除「${pack.name}」,另外 ${pack.card_count - 1} 张卡也一起解绑了`
                          : `已删除「${pack.name}」`,
                      );
                    })
                  }
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 背景表和音乐表共用的增删改 */
function useAssetOps(packId: string, kind: SceneKind, scene: ScenePluginState, notify: Props['notify']) {
  const [busy, run] = useRunner(notify, async () => {
    scene.changeAssets(packId, await debugApi.listSceneAssets(packId));
    await scene.refreshPacks();
  });
  const mine = scene.assets.filter((a) => a.kind === kind);
  const takenNames = () =>
    new Set(mine.flatMap((a) => [a.label, ...a.aliases]).map((n) => n.toLowerCase()));
  const fallback = kind === 'bg' ? '场景' : '音乐';

  return {
    busy,
    run,
    mine,
    addEmpty: () =>
      run('新建', async () => {
        await debugApi.createSceneAsset(packId, {
          kind,
          label: uniqueLabel(kind === 'bg' ? '新场景' : '新音乐', fallback, takenNames()),
        });
      }),
    batchUpload: (files: File[]) =>
      run(`上传 ${files.length} 个文件`, async () => {
        const taken = takenNames();
        for (const f of files) {
          const created = await debugApi.createSceneAsset(packId, {
            kind,
            label: uniqueLabel(labelFromFile(f.name), fallback, taken),
          });
          await debugApi.uploadSceneFile(packId, created.id, f);
        }
        notify('ok', `已添加 ${files.length} 个${fallback},记得把名字改成 AI 好理解的词`);
      }),
    replaceFile: (assetId: string, file: File) =>
      run('换文件', async () => {
        await debugApi.uploadSceneFile(packId, assetId, file);
      }),
    update: (assetId: string, patch: Parameters<typeof debugApi.updateSceneAsset>[2]) =>
      run('保存', async () => {
        await debugApi.updateSceneAsset(packId, assetId, patch);
      }),
    remove: (assetId: string) =>
      run('删除', async () => {
        await debugApi.deleteSceneAsset(packId, assetId);
      }),
    setEnabled: (assetId: string, enabled: boolean) =>
      run(enabled ? '启用' : '禁用', async () => {
        await debugApi.updateSceneAsset(packId, assetId, { enabled });
      }),
    /** 默认 = 排在最前面的、没禁用的那个 */
    defaultId: mine.find((a) => a.enabled)?.id ?? null,
    makeDefault: (assetId: string) =>
      run('排序', async () => {
        await debugApi.reorderSceneAssets(packId, kind, [
          assetId,
          ...mine.map((a) => a.id).filter((id) => id !== assetId),
        ]);
      }),
  };
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac';

function BgTable({
  packId,
  scene,
  notify,
}: {
  packId: string;
  scene: ScenePluginState;
  notify: Props['notify'];
}) {
  const ops = useAssetOps(packId, 'bg', scene, notify);
  const { busy } = ops;
  const bgms = bgmsOf(scene.assets);
  const batchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  return (
    <div className="pl-sprites">
      <div className="pl-row">
        <button className="btn small" disabled={!!busy} onClick={() => void ops.addEmpty()}>
          + 添加场景
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => batchRef.current?.click()}>
          批量上传图片
        </button>
        {busy && (
          <span className="sp-group-note">
            <span className="spinner tiny" /> {busy}…
          </span>
        )}
      </div>
      <input
        ref={batchRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void ops.batchUpload(files);
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        accept={IMAGE_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && replaceTarget.current) void ops.replaceFile(replaceTarget.current, f);
        }}
      />

      {ops.mine.length === 0 ? (
        <div className="sp-empty">
          还没有场景。批量上传时文件名就是场景名(比如 食堂.jpg);横图(16:9)效果最好。
        </div>
      ) : (
        <div className="pl-sprite-list">
          {backgroundsOf(ops.mine).map((a) => {
            const url = sceneFileUrl(a);
            return (
              <div key={a.id} className={`pl-sprite pl-scene bg${a.enabled ? '' : ' off'}`}>
                <button
                  className="pl-thumb pl-thumb-wide"
                  title={url ? '点击换图' : '点击上传图片'}
                  disabled={!!busy}
                  onClick={() => {
                    replaceTarget.current = a.id;
                    replaceRef.current?.click();
                  }}
                >
                  {url ? <img src={url} alt={a.label} /> : <span>上传</span>}
                </button>
                <LabelFields
                  noun="场景名"
                  item={a}
                  isDefault={a.id === ops.defaultId}
                  descPlaceholder="给 AI 看的:这是什么地方"
                  onCommit={(patch) => ops.update(a.id, patch)}
                >
                  <label className="pl-field">
                    <span className="conn-label">默认音乐</span>
                    <select
                      className="text-input"
                      value={a.bgm_id ?? ''}
                      disabled={!!busy}
                      onChange={(e) => void ops.update(a.id, { bgm_id: e.target.value || null })}
                    >
                      <option value="">不换(沿用之前的音乐)</option>
                      {bgms.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.enabled ? m.label : `${m.label}(已禁用,游戏里不放)`}
                        </option>
                      ))}
                    </select>
                  </label>
                  {url && (
                    <FocusSlider
                      url={url}
                      value={a.focus_x}
                      onCommit={(v) => void ops.update(a.id, { focus_x: v })}
                    />
                  )}
                </LabelFields>
                <div className="pl-actions">
                  <EnableButton
                    enabled={a.enabled}
                    disabled={!!busy}
                    onChange={(on) => void ops.setEnabled(a.id, on)}
                  />
                  <button
                    className="btn small"
                    disabled={a.id === ops.defaultId || !a.enabled || !!busy}
                    onClick={() => void ops.makeDefault(a.id)}
                    title="挪到第一个 —— 对话里还没写场景标签时用它"
                  >
                    设为默认
                  </button>
                  <DeleteButton disabled={!!busy} onConfirm={() => void ops.remove(a.id)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 竖屏焦点:手机竖着玩时只看得到横图的一窄条,拖滑条决定对准哪儿,旁边是竖屏裁切的预览 */
function FocusSlider({
  url,
  value,
  onCommit,
}: {
  url: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="pl-field">
      <span className="conn-label">竖屏焦点</span>
      <div className="pl-focus">
        <div className="pl-focus-preview" title="竖屏时看到的部分">
          <img src={url} alt="" style={{ objectPosition: `${draft}% 50%` }} />
        </div>
        <input
          className="sp-slider"
          type="range"
          min={0}
          max={100}
          value={draft}
          aria-label="竖屏焦点"
          onChange={(e) => {
            const v = Number(e.target.value);
            setDraft(v);
            // 拖动时只改预览,停手半秒再存
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => onCommit(v), 500);
          }}
        />
        <span className="sp-slider-value">{draft < 34 ? '偏左' : draft > 66 ? '偏右' : '居中'}</span>
      </div>
    </div>
  );
}

function BgmTable({
  packId,
  scene,
  notify,
}: {
  packId: string;
  scene: ScenePluginState;
  notify: Props['notify'];
}) {
  const ops = useAssetOps(packId, 'bgm', scene, notify);
  const { busy } = ops;
  const bgm = useBgm();
  const batchRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  // 关抽屉(或者离开菜单的插件页)时把试听停掉,还原成之前在放的
  useEffect(() => () => bgmPlayer.stopPreview(), []);

  const toggle = (url: string) => {
    if (bgm.preview === url) bgmPlayer.stopPreview();
    else bgmPlayer.startPreview(url);
  };

  // 哪些场景把这首当默认曲 —— 删之前心里有数
  const usedBy = (id: string) =>
    backgroundsOf(scene.assets)
      .filter((b) => b.bgm_id === id)
      .map((b) => b.label);

  return (
    <div className="pl-sprites">
      <div className="pl-row">
        <button className="btn small" disabled={!!busy} onClick={() => void ops.addEmpty()}>
          + 添加音乐
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => batchRef.current?.click()}>
          批量上传音频
        </button>
        {busy && (
          <span className="sp-group-note">
            <span className="spinner tiny" /> {busy}…
          </span>
        )}
      </div>
      <input
        ref={batchRef}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void ops.batchUpload(files);
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        accept={AUDIO_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f && replaceTarget.current) void ops.replaceFile(replaceTarget.current, f);
        }}
      />

      {ops.mine.length === 0 ? (
        <div className="sp-empty">
          还没有音乐。批量上传时文件名就是音乐名(比如 日常.mp3);建议用 MP3,iPhone 放不了 OGG。
        </div>
      ) : (
        <div className="pl-sprite-list">
          {ops.mine.map((a) => {
            const url = sceneFileUrl(a);
            const on = url !== null && bgm.preview === url;
            const used = usedBy(a.id);
            return (
              <div key={a.id} className={`pl-sprite pl-scene${a.enabled ? '' : ' off'}`}>
                <button
                  className={`pl-thumb pl-play${on ? ' on' : ''}`}
                  title={url ? (on ? '停止试听' : '试听') : '还没传文件'}
                  disabled={!url}
                  onClick={() => url && toggle(url)}
                  aria-label={on ? '停止试听' : '试听'}
                >
                  <span>{on ? '■' : '▶'}</span>
                </button>
                <LabelFields
                  noun="音乐名"
                  item={a}
                  isDefault={false}
                  descPlaceholder="给 AI 看的:什么气氛用它(曲名也可以写这里)"
                  onCommit={(patch) => ops.update(a.id, patch)}
                >
                  <div className="sp-group-note">
                    {a.has_file
                      ? `${a.mime ?? ''} · ${formatSize(a.size)}${a.mime === 'audio/ogg' ? ' · iPhone 可能放不了 OGG' : ''}`
                      : '还没传文件'}
                    {used.length > 0 && ` · 默认曲:${used.join('、')}`}
                    {on && bgm.error && <span className="pl-error"> · {bgm.error}</span>}
                  </div>
                </LabelFields>
                <div className="pl-actions">
                  <EnableButton
                    enabled={a.enabled}
                    disabled={!!busy}
                    onChange={(on) => void ops.setEnabled(a.id, on)}
                  />
                  <button
                    className="btn small"
                    disabled={!!busy}
                    onClick={() => {
                      replaceTarget.current = a.id;
                      replaceRef.current?.click();
                    }}
                  >
                    {a.has_file ? '换文件' : '上传文件'}
                  </button>
                  <DeleteButton disabled={!!busy} onConfirm={() => void ops.remove(a.id)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
