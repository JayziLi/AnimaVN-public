/**
 * 菜单里的「设置」页。视觉小说自己的偏好存 vnSettings;回车键和调试台聊天框共用,
 * 改的是 chatSettings;BGM 和语音的音量直接交给各自的播放器;
 * 语音开关、等不等语音是语音插件的配置(全局一份,和调试台插件抽屉里的是同一个)。
 * 换声音、试音、调参数在菜单的插件页(语音),这里只放个入口。
 */

import { useState, type ReactNode } from 'react';
import type { SceneAsset } from '../lib/api';
import { ENTER_KEY_MODES, type EnterKeyMode } from '../lib/chatSettings';
import {
  MAX_WAIT_MAX,
  MAX_WAIT_MIN,
  normalizeVoiceConfig,
  type VoicePluginConfig,
} from '../plugins/voice';
import { bgmPlayer, useBgm } from './bgm';
import { useVoice, voicePlayer } from './voice';
import {
  AUTO_MAX,
  AUTO_MIN,
  DUCK_LEVELS,
  OPACITY_MIN,
  SCALE_MAX,
  SCALE_MIN,
  TEXT_SPEEDS,
  TITLE_STYLES,
  type VNSettings,
} from './vnSettings';
import { VN_ACCENTS } from './accent';

const ACCENT_NOTE = {
  mono: '按钮、名牌、滑块用灰白,不抢立绘和背景的颜色',
  character: '从这张卡的立绘里取主色,和封面同一个颜色;换角色跟着变',
  pink: '原来的粉色',
} as const;

type Tab = 'text' | 'sound' | 'control' | 'display';

const TABS: { key: Tab; name: string }[] = [
  { key: 'text', name: '文字' },
  { key: 'sound', name: '声音' },
  { key: 'control', name: '操作' },
  { key: 'display', name: '显示' },
];

interface Props {
  settings: VNSettings;
  onChange: (next: VNSettings) => void;
  enterKey: EnterKeyMode;
  onChangeEnterKey: (mode: EnterKeyMode) => void;
  voiceConfig: VoicePluginConfig;
  onChangeVoiceConfig: (next: VoicePluginConfig) => void;
  /** 这张卡念台词用的声音;没绑是 null,还没选角色是 undefined */
  voiceCastName: string | null | undefined;
  /** 去插件页的语音:换声音、试音、调参数 */
  onOpenVoice: () => void;
  /** 封面音乐:这张卡的场景包里启用的 BGM、包里设的那首(null = 默认);没选角色时为 null */
  titleMusic: {
    bgms: SceneAsset[];
    value: string | null;
    onChange: (bgmId: string | null) => void;
  } | null;
}

function Row({
  label,
  value,
  beta,
  children,
}: {
  label: string;
  value?: string;
  /** 还在试的功能:名字后面挂个 BETA */
  beta?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`vn-set${value === undefined ? ' wide' : ''}`}>
      <span className="vn-set-label">
        {label}
        {beta && <span className="vn-beta">BETA</span>}
      </span>
      {children}
      {value !== undefined && <span className="vn-set-value">{value}</span>}
    </div>
  );
}

function Seg<T extends string | number | boolean>({
  options,
  value,
  onPick,
}: {
  options: { value: T; name: string; disabled?: boolean }[];
  value: T;
  onPick: (v: T) => void;
}) {
  return (
    <div className="vn-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          disabled={o.disabled}
          onClick={() => onPick(o.value)}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

const ON_OFF = [
  { value: true, name: '显示' },
  { value: false, name: '不显示' },
];

export function VNSettingsPage({
  settings,
  onChange,
  enterKey,
  onChangeEnterKey,
  voiceConfig,
  onChangeVoiceConfig,
  voiceCastName,
  onOpenVoice,
  titleMusic,
}: Props) {
  const [tab, setTab] = useState<Tab>('text');
  const bgm = useBgm();
  const voice = useVoice();
  const set = <K extends keyof VNSettings>(k: K, v: VNSettings[K]) => onChange({ ...settings, [k]: v });
  const setVoice = <K extends keyof VoicePluginConfig>(k: K, v: VoicePluginConfig[K]) =>
    onChangeVoiceConfig(normalizeVoiceConfig({ ...voiceConfig, [k]: v }));

  return (
    <div className="vn-settings">
      <div className="vn-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`vn-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.name}
          </button>
        ))}
      </div>

      {tab === 'text' && (
        <div className="vn-set-list">
          <Row label="文字速度">
            <Seg options={TEXT_SPEEDS} value={settings.textSpeed} onPick={(v) => set('textSpeed', v)} />
          </Row>
          <Row label="自动播放间隔" value={`${(settings.autoDelay / 1000).toFixed(1)} 秒`}>
            <input
              type="range"
              min={AUTO_MIN}
              max={AUTO_MAX}
              step={100}
              value={settings.autoDelay}
              aria-label="自动播放间隔"
              onChange={(e) => set('autoDelay', Number(e.target.value))}
            />
          </Row>
          <Row label="文本框透明度" value={`${Math.round(settings.boxOpacity * 100)}%`}>
            <input
              type="range"
              min={OPACITY_MIN * 100}
              max={100}
              value={Math.round(settings.boxOpacity * 100)}
              aria-label="文本框不透明度"
              onChange={(e) => set('boxOpacity', Number(e.target.value) / 100)}
            />
          </Row>
          <Row label="对白字号" value={`${Math.round(settings.textScale * 100)}%`}>
            <input
              type="range"
              min={SCALE_MIN * 100}
              max={SCALE_MAX * 100}
              step={5}
              value={Math.round(settings.textScale * 100)}
              aria-label="对白字号"
              onChange={(e) => set('textScale', Number(e.target.value) / 100)}
            />
          </Row>
        </div>
      )}

      {tab === 'sound' && (
        <div className="vn-set-list">
          <div className="vn-set-group">音乐</div>
          <Row label="BGM 音量" value={bgm.muted ? '静音' : `${Math.round(bgm.volume * 100)}%`}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(bgm.volume * 100)}
              aria-label="BGM 音量"
              onChange={(e) => {
                bgmPlayer.setVolume(Number(e.target.value) / 100);
                if (bgm.muted) bgmPlayer.setMuted(false);
              }}
            />
          </Row>
          <Row label="BGM">
            <Seg
              options={[
                { value: false, name: '有声' },
                { value: true, name: '静音' },
              ]}
              value={bgm.muted}
              onPick={(v) => bgmPlayer.setMuted(v)}
            />
          </Row>
          <Row label="念台词时">
            <div className="vn-set-stack">
              <Seg options={DUCK_LEVELS} value={settings.duckLevel} onPick={(v) => set('duckLevel', v)} />
              <span className="vn-set-note">角色说话时把音乐压到多低,念完自己淡回来</span>
            </div>
          </Row>
          {bgm.error && <p className="vn-set-error">{bgm.error}</p>}

          <div className="vn-set-group">
            语音
            {voiceCastName !== undefined && (
              <span className="vn-set-note">
                {voiceCastName ? `这张卡用「${voiceCastName}」的声音` : '这张卡还没绑声音'}
              </span>
            )}
            <button className="vn-pill" onClick={onOpenVoice}>
              换声音 · 试音 · 调参数
            </button>
          </div>
          <Row label="语音合成">
            <div className="vn-set-stack">
              <Seg
                options={[
                  { value: true, name: '开' },
                  { value: false, name: '关' },
                ]}
                value={voiceConfig.enabled}
                onPick={(v) => setVoice('enabled', v)}
              />
              <span className="vn-set-note">
                关掉就不再请求语音服务 · 所有角色通用,和调试台插件里的开关是同一个
              </span>
            </div>
          </Row>
          {voiceConfig.enabled && (
            <>
              <Row label="语音音量" value={voice.muted ? '静音' : `${Math.round(voice.volume * 100)}%`}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(voice.volume * 100)}
                  aria-label="语音音量"
                  onChange={(e) => {
                    voicePlayer.setVolume(Number(e.target.value) / 100);
                    if (voice.muted) voicePlayer.setMuted(false);
                  }}
                />
              </Row>
              <Row label="语音">
                <Seg
                  options={[
                    { value: false, name: '有声' },
                    { value: true, name: '静音' },
                  ]}
                  value={voice.muted}
                  onPick={(v) => voicePlayer.setMuted(v)}
                />
              </Row>
              <Row label="文字和语音">
                <div className="vn-set-stack">
                  <Seg
                    options={[
                      { value: false, name: '先出文字' },
                      { value: true, name: '等语音' },
                    ]}
                    value={voiceConfig.waitForVoice}
                    onPick={(v) => setVoice('waitForVoice', v)}
                  />
                  <span className="vn-set-note">
                    {voiceConfig.waitForVoice
                      ? '语音好了文字和声音一起出;等太久就先出文字'
                      : '文字直接出,语音还在生成时字后面转个圈,好了自己念'}
                  </span>
                </div>
              </Row>
              {voiceConfig.waitForVoice && (
                <Row label="最多等" value={`${voiceConfig.maxWaitSec} 秒`}>
                  <input
                    type="range"
                    min={MAX_WAIT_MIN}
                    max={MAX_WAIT_MAX}
                    step={1}
                    value={voiceConfig.maxWaitSec}
                    aria-label="等语音最多等几秒"
                    onChange={(e) => setVoice('maxWaitSec', Number(e.target.value))}
                  />
                </Row>
              )}
              <Row label="语音情绪">
                <div className="vn-set-stack">
                  <Seg
                    options={[
                      { value: false, name: '跟着表情' },
                      { value: true, name: '不变' },
                    ]}
                    value={voiceConfig.fixedEmotion}
                    onPick={(v) => setVoice('fixedEmotion', v)}
                  />
                  <span className="vn-set-note">
                    {voiceConfig.fixedEmotion
                      ? '每句都用默认情绪念(声音情绪表里排第一的那行)'
                      : '这句立绘是什么表情,就用对应的情绪念'}
                  </span>
                </div>
              </Row>
              <Row label="翻页时">
                <Seg
                  options={[
                    { value: true, name: '停止语音' },
                    { value: false, name: '念完为止' },
                  ]}
                  value={settings.voiceInterrupt}
                  onPick={(v) => set('voiceInterrupt', v)}
                />
              </Row>
              <Row label="自动播放">
                <Seg
                  options={[
                    { value: true, name: '等语音念完再翻' },
                    { value: false, name: '不等语音' },
                  ]}
                  value={settings.autoWaitVoice}
                  onPick={(v) => set('autoWaitVoice', v)}
                />
              </Row>
              {voice.lastError && voice.failures > 0 && (
                <p className="vn-set-error">语音最近一次失败:{voice.lastError}</p>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'control' && (
        <div className="vn-set-list">
          <Row label="回车键">
            <div className="vn-set-stack">
              <Seg
                options={ENTER_KEY_MODES.map((m) => ({ value: m.value, name: m.name }))}
                value={enterKey}
                onPick={onChangeEnterKey}
              />
              <span className="vn-set-note">
                {ENTER_KEY_MODES.find((m) => m.value === enterKey)?.note} · 和调试台聊天框共用
              </span>
            </div>
          </Row>
          <Row label="快捷键">
            <div className="vn-keys">
              <span><kbd>空格</kbd> / <kbd>回车</kbd> 下一句</span>
              <span>按住 <kbd>Ctrl</kbd> 跳过</span>
              <span><kbd>A</kbd> 自动播放</span>
              <span><kbd>Esc</kbd> 菜单</span>
              <span><kbd>滚轮↑</kbd> 历史</span>
              <span><kbd>右键</kbd> 隐藏界面</span>
            </div>
          </Row>
        </div>
      )}

      {tab === 'display' && (
        <div className="vn-set-list">
          <Row label="思考过程">
            <Seg options={ON_OFF} value={settings.showThinking} onPick={(v) => set('showThinking', v)} />
          </Row>
          <Row label="模型标签">
            <Seg options={ON_OFF} value={settings.showModel} onPick={(v) => set('showModel', v)} />
          </Row>
          <Row label="标题画面" beta>
            <Seg
              options={[
                { value: true, name: '进来先看' },
                { value: false, name: '直接继续' },
              ]}
              value={settings.titleScreen}
              onPick={(v) => set('titleScreen', v)}
            />
          </Row>
          <Row label="封面样式" beta>
            <div className="vn-set-stack">
              <Seg options={TITLE_STYLES} value={settings.titleStyle} onPick={(v) => set('titleStyle', v)} />
              <span className="vn-set-note">
                {settings.titleStyle === 'poster'
                  ? '斜切纸面排版,纸面跟着背景变色;左边的头像点一下换角色'
                  : '场景轮流淡入的片头,最后回到上次的地方;点「继续」直接接着玩'}
                {' · 菜单「返回标题」看效果'}
              </span>
            </div>
          </Row>
          <Row label="封面音乐" beta>
            <div className="vn-set-stack">
              {titleMusic && titleMusic.bgms.length > 0 ? (
                <>
                  <select
                    className="vn-set-select"
                    aria-label="封面音乐"
                    // 设的那首删了或禁用了,下拉显示回默认(游戏里也是放排第一的)
                    value={titleMusic.bgms.some((b) => b.id === titleMusic.value) ? (titleMusic.value ?? '') : ''}
                    onChange={(e) => titleMusic.onChange(e.target.value || null)}
                  >
                    <option value="">默认:排第一的({titleMusic.bgms[0].label})</option>
                    {titleMusic.bgms.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                  <span className="vn-set-note">
                    标题画面放这首,点「继续」换回场景的音乐 · 记在这张卡的场景包上,绑同一个包的角色共用
                  </span>
                </>
              ) : (
                <span className="vn-set-note">
                  {titleMusic ? '这张卡的场景包里还没有 BGM,封面不放音乐' : '先选一个角色'}
                </span>
              )}
            </div>
          </Row>
          <Row label="主题色">
            <div className="vn-set-stack">
              <Seg options={VN_ACCENTS} value={settings.accent} onPick={(v) => set('accent', v)} />
              <span className="vn-set-note">{ACCENT_NOTE[settings.accent]}</span>
            </div>
          </Row>
          <Row label="界面样式">
            <Seg
              options={[
                { value: 'default', name: '默认' },
                { value: 'more', name: '更多样式开发中', disabled: true },
              ]}
              value="default"
              onPick={() => {}}
            />
          </Row>
        </div>
      )}
    </div>
  );
}
