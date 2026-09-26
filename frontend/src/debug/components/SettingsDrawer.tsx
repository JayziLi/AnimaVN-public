import { useState } from 'react';
import {
  AVATAR_MAX,
  AVATAR_MIN,
  AVATAR_SHAPES,
  AVATAR_STEP,
  CHAT_WIDTHS,
  DEFAULT_CHAT_SETTINGS,
  ENTER_KEY_MODES,
  FONT_MAX,
  FONT_MIN,
  FONT_STEP,
  LAYOUTS,
  LINE_HEIGHTS,
  QUOTE_COLORS,
  avatarRadius,
  isDefaultChatSettings,
  type ChatLayout,
  type ChatSettings,
} from '../lib/chatSettings';
import { renderQuoted } from '../lib/richText';
import { DEFAULT_AVATAR } from '../lib/avatar';
import {
  BUILTIN_MACROS,
  RESERVED_MACRO_NAMES,
  substituteMacros,
  type MacroContext,
} from '../lib/macros';
import { NAME_RE, type CustomMacro } from '../lib/customMacros';

interface Props {
  settings: ChatSettings;
  /** 受控:改一个字段就整个回传,由外层统一 setState + 落盘 */
  onChange: (next: ChatSettings) => void;
  /** 当前这一刻各宏会展开成什么 —— 宏页那张表直接读它 */
  macros: MacroContext;
  custom: CustomMacro[];
  onChangeCustom: (next: CustomMacro[]) => void;
  onClose: () => void;
}

/** 以后加分类往这里加一行,右边再多一个分支 */
const SECTIONS = [
  { key: 'chat', name: '聊天', icon: '💬' },
  { key: 'macro', name: '宏', icon: '{}' },
] as const;
type SectionKey = (typeof SECTIONS)[number]['key'];

/**
 * 排版方案的缩略图 —— 光看名字和一句说明,想象不出来到底长什么样。
 * 这里用几个灰条摆出各方案的骨架:头像在不在、消息靠哪边、有没有框、多密。
 */
function LayoutPreview({ kind }: { kind: ChatLayout }) {
  const lines = (n: number) => (
    <div className="sp-prev-lines">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );

  if (kind === 'duo') {
    return (
      <div className="sp-prev sp-prev-duo">
        <div className="sp-prev-row">
          <span className="sp-prev-face" />
          <div className="sp-prev-bubble">{lines(2)}</div>
        </div>
        <div className="sp-prev-row mine">
          <div className="sp-prev-bubble">{lines(1)}</div>
        </div>
      </div>
    );
  }

  if (kind === 'document') {
    return (
      <div className="sp-prev sp-prev-document">
        <div className="sp-prev-row">
          <div className="sp-prev-bare">
            <span className="sp-prev-name" />
            {lines(3)}
          </div>
        </div>
        <div className="sp-prev-rule" />
        <div className="sp-prev-row">
          <div className="sp-prev-bare">
            <span className="sp-prev-name" />
            {lines(2)}
          </div>
        </div>
      </div>
    );
  }

  if (kind === 'compact') {
    return (
      <div className="sp-prev sp-prev-compact">
        {[2, 1, 2].map((n, i) => (
          <div className="sp-prev-row" key={i}>
            <span className="sp-prev-face" />
            <div className="sp-prev-bubble">{lines(n)}</div>
          </div>
        ))}
      </div>
    );
  }

  if (kind === 'script') {
    return (
      <div className="sp-prev sp-prev-script">
        <div className="sp-prev-row">
          <div className="sp-prev-bare">
            <span className="sp-prev-plate" />
            <div className="sp-prev-quoted">{lines(3)}</div>
          </div>
        </div>
        <div className="sp-prev-row">
          <div className="sp-prev-bare">
            <span className="sp-prev-plate short" />
            <div className="sp-prev-quoted">{lines(1)}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-prev sp-prev-bubble">
      <div className="sp-prev-row">
        <span className="sp-prev-face" />
        <div className="sp-prev-bubble">{lines(3)}</div>
      </div>
      <div className="sp-prev-row">
        <span className="sp-prev-face" />
        <div className="sp-prev-bubble">{lines(1)}</div>
      </div>
    </div>
  );
}

const SAMPLE =
  '他把伞收了收,侧过身让出半边路。「今天风大,你走里面。」\n她没接话,只是笑了笑:"那你呢?"';

const TRY_SAMPLE = '{{char}} 看了 {{user}} 一眼:「又是你。」';

/** 一行自定义宏的毛病。null = 没毛病 */
function macroFault(
  m: CustomMacro,
  index: number,
  list: readonly CustomMacro[],
): string | null {
  const name = m.name.trim();
  if (!name) return '还没起名字 —— 这行不会生效';
  if (!NAME_RE.test(name)) return '名字里不能有大括号、冒号或空格';
  if (RESERVED_MACRO_NAMES.has(name.toLowerCase())) return '这个名字被内置宏占了,内置的优先';
  const dup = list.findIndex(
    (o, i) => i !== index && o.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (dup !== -1 && dup < index) return '和上面某一行重名了,只有最后一行生效';
  return null;
}

/**
 * 「设置 › 宏」。两件事:把当前的宏映射摊开给人看,以及让人自己加几个。
 *
 * 表里的「当前值」读的是真实 ctx —— 所以它也是个诊断工具:{{persona}} 显示
 * 「(空)」就说明你还没激活人设,不用去猜为什么提示词里那块是空的。
 */
function MacroSection({
  macros,
  custom,
  onChangeCustom,
}: {
  macros: MacroContext;
  custom: CustomMacro[];
  onChangeCustom: (next: CustomMacro[]) => void;
}) {
  const [tryText, setTryText] = useState(TRY_SAMPLE);
  const [copied, setCopied] = useState<string | null>(null);

  const patchRow = (i: number, p: Partial<CustomMacro>) =>
    onChangeCustom(custom.map((m, j) => (i === j ? { ...m, ...p } : m)));

  const copy = (syntax: string) => {
    void navigator.clipboard?.writeText(syntax).then(
      () => {
        setCopied(syntax);
        window.setTimeout(() => setCopied((c) => (c === syntax ? null : c)), 1200);
      },
      () => {},
    );
  };

  return (
    <>
      {/* ── 内置宏:当前映射到什么 ── */}
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">内置宏</span>
          <span className="sp-group-note">
            当前这一刻的实际取值 · 点宏名可复制 · 组装提示词和聊天区显示用的是同一份
          </span>
        </div>

        <div className="sp-macro-table">
          <div className="sp-macro-row head">
            <span>宏</span>
            <span>说明</span>
            <span>当前值</span>
          </div>
          {BUILTIN_MACROS.map((m) => {
            const v = m.value(macros);
            return (
              <div className="sp-macro-row" key={m.key}>
                <button
                  className={`sp-macro-name${copied === m.syntax ? ' copied' : ''}`}
                  onClick={() => copy(m.syntax)}
                  title="点一下复制"
                >
                  {copied === m.syntax ? '已复制' : m.syntax}
                </button>
                <span className="sp-macro-note">
                  {m.note}
                  {m.alias?.length ? (
                    <span className="sp-macro-alias">别名 {`{{${m.alias[0]}}}`}</span>
                  ) : null}
                </span>
                {m.dynamic ? (
                  <span className="sp-macro-value dyn" title="每次求值都可能不同">
                    {m.key === 'time' || m.key === 'date' ? v : '每次求值都不同'}
                  </span>
                ) : v ? (
                  <span className="sp-macro-value" title={v}>
                    {v.length > 60 ? `${v.slice(0, 60)}…` : v}
                  </span>
                ) : (
                  <span className="sp-macro-value empty">(空)</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 自定义宏 ── */}
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">自定义宏</span>
          <span className="sp-group-note">
            值里可以再套宏(比如 {'{{char}}'});内置宏优先,占不到上面那些名字
          </span>
        </div>

        {custom.length === 0 && (
          <div className="sp-empty">
            还没有自定义宏。加一个之后,预设、角色卡、聊天输入里写 {'{{名字}}'} 都会展开。
          </div>
        )}

        <div className="sp-custom-list">
          {custom.map((m, i) => {
            const fault = macroFault(m, i, custom);
            return (
              <div className={`sp-custom-row${fault ? ' bad' : ''}`} key={i}>
                <div className="sp-custom-name">
                  <span className="sp-brace">{'{{'}</span>
                  <input
                    className="conn-input"
                    value={m.name}
                    placeholder="名字"
                    spellCheck={false}
                    onChange={(e) => patchRow(i, { name: e.target.value })}
                  />
                  <span className="sp-brace">{'}}'}</span>
                </div>
                <textarea
                  className="conn-input sp-custom-value"
                  value={m.value}
                  placeholder="展开成什么"
                  rows={2}
                  onChange={(e) => patchRow(i, { value: e.target.value })}
                />
                <button
                  className="icon-btn tiny"
                  onClick={() => onChangeCustom(custom.filter((_, j) => j !== i))}
                  title="删掉这个宏"
                >
                  ✕
                </button>
                {fault && <span className="sp-custom-fault">{fault}</span>}
              </div>
            );
          })}
        </div>

        <button
          className="btn small"
          onClick={() => onChangeCustom([...custom, { name: '', value: '' }])}
        >
          ＋ 新增宏
        </button>
      </div>

      {/* ── 试一试:写对没有,当场就知道 ── */}
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">试一试</span>
          <span className="sp-group-note">左边随便写,右边是展开后的样子</span>
        </div>
        <div className="sp-try">
          <textarea
            className="conn-input sp-try-in"
            value={tryText}
            rows={4}
            spellCheck={false}
            onChange={(e) => setTryText(e.target.value)}
          />
          <div className="sp-try-out">{substituteMacros(tryText, macros) || '(空)'}</div>
        </div>
      </div>
    </>
  );
}

export function SettingsDrawer({
  settings,
  onChange,
  macros,
  custom,
  onChangeCustom,
  onClose,
}: Props) {
  const [section, setSection] = useState<SectionKey>('chat');
  // 一次点掉一屏的调校,和删消息一样走「再点一次」确认,不弹窗
  const [armed, setArmed] = useState(false);

  const patch = (p: Partial<ChatSettings>) => {
    setArmed(false);
    onChange({ ...settings, ...p });
  };
  const percent = Math.round(settings.fontScale * 100);

  // 「恢复默认」只管当前分类 —— 在宏页上点它却把排版清了,没人会预料到
  const pristine = section === 'chat' ? isDefaultChatSettings(settings) : custom.length === 0;
  const restoreTitle =
    section === 'chat'
      ? pristine
        ? '当前全是默认值'
        : '把「聊天」这一页恢复成默认'
      : pristine
        ? '还没有自定义宏'
        : '清空所有自定义宏';
  const restoreLabel = section === 'chat' ? '恢复默认' : '清空自定义宏';

  const restore = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    if (section === 'chat') onChange(DEFAULT_CHAT_SETTINGS);
    else onChangeCustom([]);
  };

  return (
    <div className="conn-drawer sp-drawer">
      <div className="conn-drawer-head">
        <span className="conn-drawer-title">设置 · PREFERENCES</span>
        <span className="conn-drawer-sub">
          {section === 'chat'
            ? '只影响这台机器上的显示,不改提示词、不入库'
            : '存在这台机器上,不入库 —— 但它会进提示词'}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className={`btn small${armed ? ' danger armed' : ''}`}
          disabled={pristine}
          onClick={restore}
          onBlur={() => setArmed(false)}
          title={restoreTitle}
        >
          {armed ? '再点一次确认' : restoreLabel}
        </button>
        <button className="panel-collapse" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      <div className="sp-main">
        <div className="sp-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={`sp-nav-item${section === s.key ? ' active' : ''}`}
              onClick={() => {
                // 换页时解除待确认:那颗按钮在两页上干的事不一样
                setArmed(false);
                setSection(s.key);
              }}
            >
              <span className="sp-nav-icon" aria-hidden>
                {s.icon}
              </span>
              {s.name}
            </button>
          ))}
        </div>

        <div className="sp-body">
          {section === 'macro' && (
            <MacroSection macros={macros} custom={custom} onChangeCustom={onChangeCustom} />
          )}

          {section === 'chat' && (
            <>
          {/* ── 排版 ── */}
          <div className="sp-group">
            <div className="sp-group-head">
              <span className="sp-group-title">排版</span>
              <span className="sp-group-note">消息在聊天区怎么摆</span>
            </div>
            <div className="sp-layouts">
              {LAYOUTS.map((l) => (
                <button
                  key={l.key}
                  className={`sp-layout${settings.layout === l.key ? ' active' : ''}`}
                  onClick={() => patch({ layout: l.key })}
                  title={l.note}
                >
                  <LayoutPreview kind={l.key} />
                  <span className="sp-layout-name">{l.name}</span>
                  <span className="sp-layout-note">{l.note}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── 字号 / 行距 / 列宽:都是「一屏能舒服地读多少字」 ── */}
          <div className="sp-group">
            <div className="sp-group-head">
              <span className="sp-group-title">字号与版式</span>
              <span className="sp-group-note">
                正文、昵称、模型信息整块一起缩放;头像另有一条,见下
              </span>
            </div>

            <div className="sp-field">
              <span className="conn-label">字号</span>
              <div className="sp-slider-row">
                <input
                  className="sp-slider"
                  type="range"
                  min={FONT_MIN}
                  max={FONT_MAX}
                  step={FONT_STEP}
                  value={settings.fontScale}
                  onChange={(e) => patch({ fontScale: Number(e.target.value) })}
                />
                <span className="sp-slider-value">{percent}%</span>
                <button
                  className="btn small"
                  disabled={settings.fontScale === DEFAULT_CHAT_SETTINGS.fontScale}
                  onClick={() => patch({ fontScale: DEFAULT_CHAT_SETTINGS.fontScale })}
                  title="回到 100%"
                >
                  重置
                </button>
              </div>
            </div>

            <div className="sp-duo-fields">
              <div className="sp-field">
                <span className="conn-label">行距</span>
                <div className="sp-seg">
                  {LINE_HEIGHTS.map((h) => (
                    <button
                      key={h.value}
                      className={`sp-seg-btn${settings.lineHeight === h.value ? ' active' : ''}`}
                      onClick={() => patch({ lineHeight: h.value })}
                    >
                      {h.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sp-field">
                <span className="conn-label">消息列宽度</span>
                <div className="sp-seg">
                  {CHAT_WIDTHS.map((w) => (
                    <button
                      key={w.value}
                      className={`sp-seg-btn${settings.chatWidth === w.value ? ' active' : ''}`}
                      onClick={() => patch({ chatWidth: w.value })}
                      title={w.value === 0 ? '铺满聊天区' : `最宽 ${w.value}px`}
                    >
                      {w.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── 头像:和字号分开一条,对齐 Discord 的 Zoom / Font Scaling 两条旋钮 ── */}
          <div className="sp-group">
            <div className="sp-group-head">
              <span className="sp-group-title">头像</span>
              <span className="sp-group-note">「文档」和「剧本」两套排版不显示头像</span>
            </div>

            <div className="sp-avatar-row">
              {/* 所见即所得:大小和形状立刻反映在这张脸上 */}
              <div className="sp-avatar-cell">
                <img
                  className="sp-avatar-demo"
                  src={DEFAULT_AVATAR}
                  alt=""
                  style={{
                    width: settings.avatarSize,
                    height: settings.avatarSize,
                    borderRadius: avatarRadius(settings.avatarShape),
                  }}
                />
              </div>
              <div className="sp-avatar-controls">
                <div className="sp-field">
                  <span className="conn-label">大小</span>
                  <div className="sp-slider-row">
                    <input
                      className="sp-slider"
                      type="range"
                      min={AVATAR_MIN}
                      max={AVATAR_MAX}
                      step={AVATAR_STEP}
                      value={settings.avatarSize}
                      onChange={(e) => patch({ avatarSize: Number(e.target.value) })}
                    />
                    <span className="sp-slider-value">{settings.avatarSize}px</span>
                    <button
                      className="btn small"
                      disabled={settings.avatarSize === DEFAULT_CHAT_SETTINGS.avatarSize}
                      onClick={() => patch({ avatarSize: DEFAULT_CHAT_SETTINGS.avatarSize })}
                      title="回到 36px"
                    >
                      重置
                    </button>
                  </div>
                </div>

                <div className="sp-field">
                  <span className="conn-label">形状</span>
                  <div className="sp-seg">
                    {AVATAR_SHAPES.map((s) => (
                      <button
                        key={s.value}
                        className={`sp-seg-btn${settings.avatarShape === s.value ? ' active' : ''}`}
                        onClick={() => patch({ avatarShape: s.value })}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── 回车键 ── */}
          <div className="sp-group">
            <div className="sp-group-head">
              <span className="sp-group-title">回车键</span>
              <span className="sp-group-note">
                输入框里按回车是发送还是换行。调试台的聊天框和视觉小说的输入框都按这个来;只存在这台设备上
              </span>
            </div>
            <div className="sp-seg">
              {ENTER_KEY_MODES.map((m) => (
                <button
                  key={m.value}
                  className={`sp-seg-btn${settings.enterKey === m.value ? ' active' : ''}`}
                  onClick={() => patch({ enterKey: m.value })}
                  title={m.note}
                >
                  {m.name}
                </button>
              ))}
            </div>
            <span className="sp-group-note">
              {ENTER_KEY_MODES.find((m) => m.value === settings.enterKey)?.note}
            </span>
          </div>

          {/* ── 引号高亮 ── */}
          <div className="sp-group">
            <div className="sp-group-head">
              <span className="sp-group-title">对话高亮</span>
              <span className="sp-group-note">
                引号里的内容单独上色 —— 一眼分清「在说话」和「在叙述」
              </span>
            </div>

            <button
              className="sp-switch"
              onClick={() => patch({ highlightQuotes: !settings.highlightQuotes })}
            >
              <span className={`block-toggle${settings.highlightQuotes ? ' on' : ''}`}>
                <span className="knob" />
              </span>
              <span className="sp-switch-label">
                {settings.highlightQuotes ? '已开启' : '已关闭'}
              </span>
              <span className="sp-switch-note">
                “” 「」 『』 «» 等六种成对引号 · 只认成对的,也不跨行
              </span>
            </button>

            {settings.highlightQuotes && (
              <>
                <div className="sp-field">
                  <span className="conn-label">颜色</span>
                  <div className="sp-swatches">
                    {QUOTE_COLORS.map((c) => (
                      <button
                        key={c.value}
                        className={`sp-swatch${settings.quoteColor === c.value ? ' active' : ''}`}
                        style={{ '--sw': c.value } as React.CSSProperties}
                        onClick={() => patch({ quoteColor: c.value })}
                        title={c.name}
                        aria-label={c.name}
                      />
                    ))}
                  </div>
                </div>

                {/* 所见即所得:换色/开关立刻在这段样例上生效 */}
                <div
                  className="sp-sample"
                  style={
                    {
                      '--quote': settings.quoteColor,
                      fontSize: `calc(13px * ${settings.fontScale})`,
                      lineHeight: settings.lineHeight,
                    } as React.CSSProperties
                  }
                >
                  {renderQuoted(SAMPLE, settings.highlightQuotes)}
                </div>
              </>
            )}
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
