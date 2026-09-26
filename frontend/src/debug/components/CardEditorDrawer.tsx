import { useMemo, useRef, useState } from 'react';
import type { AssemblyResult, BudgetReport, PromptPart } from '../lib/assembler';
import type { TavernCard } from '../lib/cardParser';
import type { PresetOrderEntry, TavernPreset } from '../lib/presetParser';
// 这张表块详情弹窗也要读(反向查 marker 的内容来源),所以搬进了 lib
import { PROMPT_FIELDS, type PromptFieldDef } from '../lib/cardFields';
import { estimateTokens, formatTokens } from '../lib/tokens';

/**
 * 角色卡完整编辑抽屉 —— 右滑,和完整提示词检视器同一套范式。
 *
 * 分组不按「基础 / 高级」,按**会不会进提示词**分。进提示词的那批还按预设编排的
 * 真实顺序排,序号就是它在最终消息列表里的下标。改提示词时真正要回答的问题是
 * 「我这段字最后出现在哪、排第几、占多少 token、会不会根本没发出去」。
 */


type FieldStatus =
  /** 生效,已进提示词 */
  | 'active'
  /** 字段是空的 */
  | 'empty'
  /** 有内容,但这块在编排里被关了 */
  | 'disabled'
  /** 有内容,但预设里压根没这块 */
  | 'missing'
  /** 有内容,但这块标了 forbid_overrides,覆盖不了 */
  | 'forbidden'
  /** 还没选预设,算不出来 */
  | 'unknown';

interface FieldState {
  def: PromptFieldDef;
  value: string;
  status: FieldStatus;
  /** 在最终消息列表里的下标,未生效时为 null */
  seq: number | null;
  tokens: number;
  /** 这个字段最终产生的消息,预览就是它 */
  produced: { role: string; content: string }[];
  sortKey: number;
}

const STATUS_NOTE: Record<Exclude<FieldStatus, 'active' | 'empty'>, string> = {
  disabled: '这块在当前编排里被关掉了 —— 填了也不会发出去',
  missing: '当前预设里没有这个块 —— 填了也不会发出去',
  forbidden: '这块标了 forbid_overrides —— 预设不允许角色卡覆盖它',
  unknown: '还没选预设,算不出装配位置',
};

interface Props {
  card: TavernCard;
  preset: TavernPreset | null;
  order: PresetOrderEntry[];
  /** 下一次请求真正会发出去的东西 —— 序号、token、预览全从这里读,不重算 */
  result: AssemblyResult;
  /** 上下文预算,null = 不截断。竖条的满刻度和那条「线」用它 */
  budget: number | null;
  avatarUrl: string | null;
  onChange: (patch: Partial<TavernCard>) => void;
  onPickAvatar: () => void;
  onClose: () => void;
}

export function CardEditorDrawer({
  card,
  preset,
  order,
  result,
  budget,
  avatarUrl,
  onChange,
  onPickAvatar,
  onClose,
}: Props) {
  const [active, setActive] = useState<string>('description');
  const [openPreview, setOpenPreview] = useState<Record<string, boolean>>({});
  const [showTokens, setShowTokens] = useState(false);
  const [greetingIndex, setGreetingIndex] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sections = useRef<Record<string, HTMLDivElement | null>>({});

  const fields: FieldState[] = useMemo(() => {
    const orderIndex = new Map(order.map((e, i) => [e.identifier, i]));

    const computed = PROMPT_FIELDS.map((def): FieldState => {
      const value = card[def.key];
      const produced = result.messages.filter(
        (m) =>
          m.sourceIdentifier === def.target &&
          // 覆盖类的块即使卡不填也会出消息(用的是预设原文),那不算这个字段的产出
          (def.mode === 'marker' || m.part === 'card'),
      );
      const block = preset?.prompts.find((p) => p.identifier === def.target);
      const entry = order.find((e) => e.identifier === def.target);

      let status: FieldStatus;
      if (!preset) status = 'unknown';
      else if (!value.trim()) status = 'empty';
      else if (!block) status = 'missing';
      else if (!entry?.enabled) status = 'disabled';
      else if (def.mode === 'override' && block.forbidOverrides) status = 'forbidden';
      else if (produced.length > 0) status = 'active';
      else status = 'disabled';

      const first = produced[0];
      return {
        def,
        value,
        status,
        seq: first ? result.messages.indexOf(first) : null,
        tokens: produced.reduce((n, m) => n + m.tokens, 0),
        produced: produced.map((m) => ({ role: m.role, content: m.content })),
        sortKey: orderIndex.get(def.target) ?? 100 + def.fallback,
      };
    });

    return computed.sort((a, b) => a.sortKey - b.sortKey);
  }, [card, preset, order, result]);

  const promptTokens = fields.reduce((n, f) => n + f.tokens, 0);
  const warnCount = fields.filter(
    (f) => f.status === 'disabled' || f.status === 'missing' || f.status === 'forbidden',
  ).length;

  const jump = (key: string) => {
    setActive(key);
    sections.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 滚动联动目录高亮:取最靠近顶部、且还没滚过头的那一节
  const onScroll = () => {
    const box = bodyRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let best: string | null = null;
    for (const [key, el] of Object.entries(sections.current)) {
      if (!el) continue;
      if (el.getBoundingClientRect().top - top <= 12) best = key;
    }
    if (best && best !== active) setActive(best);
  };

  const bindSection = (key: string) => (el: HTMLDivElement | null) => {
    sections.current[key] = el;
  };

  // ---- 开场白:主开场 + 其他开场合成一个可翻页的列表 ----
  const greetings = [card.first_mes, ...card.alternate_greetings];
  const activeGreeting = greetings[greetingIndex] ?? '';

  const setGreeting = (v: string) => {
    if (greetingIndex === 0) {
      onChange({ first_mes: v });
    } else {
      const next = [...card.alternate_greetings];
      next[greetingIndex - 1] = v;
      onChange({ alternate_greetings: next });
    }
  };

  return (
    <div className="ce-backdrop" onClick={onClose}>
      <div className="ce-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ce-head">
          <button className="ce-avatar-btn" onClick={onPickAvatar} title="点击更换头像">
            {avatarUrl ? (
              <img className="ce-avatar" src={avatarUrl} alt={card.name} />
            ) : (
              <div className="ce-avatar placeholder">NO IMG</div>
            )}
          </button>
          <input
            className="ce-name-input"
            value={card.name}
            placeholder="(无名)"
            onChange={(e) => onChange({ name: e.target.value })}
          />
          <span className="ce-head-tag">角色卡编辑</span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="ce-main">
          <nav className="ce-nav">
            <div className="ce-nav-group">进入提示词</div>
            {fields.map((f) => (
              <button
                key={f.def.key}
                className={`ce-nav-item${active === f.def.key ? ' active' : ''}`}
                onClick={() => jump(f.def.key)}
              >
                <span className={`ce-nav-seq ${f.status}`}>
                  {f.seq !== null ? `#${String(f.seq).padStart(2, '0')}` : '—'}
                </span>
                <span className="ce-nav-label">{f.def.label.split(' · ')[0]}</span>
                <span className={`ce-nav-token ${f.status}`}>
                  {f.status === 'empty'
                    ? '空'
                    : f.status === 'active'
                      ? formatTokens(f.tokens)
                      : '!'}
                </span>
              </button>
            ))}

            <div className="ce-nav-group">不进提示词</div>
            {[
              { key: 'greetings', label: '开场白', note: `${greetings.length} 条` },
              { key: 'notes', label: '创作者注释', note: '' },
              { key: 'meta', label: '标签 / 元数据', note: '' },
              ...(card.character_book
                ? [
                    {
                      key: 'book',
                      label: '角色世界书',
                      note: `${card.character_book.entries.length} 条`,
                    },
                  ]
                : []),
            ].map((s) => (
              <button
                key={s.key}
                className={`ce-nav-item${active === s.key ? ' active' : ''}`}
                onClick={() => jump(s.key)}
              >
                <span className="ce-nav-seq muted">·</span>
                <span className="ce-nav-label">{s.label}</span>
                <span className="ce-nav-token muted">{s.note}</span>
              </button>
            ))}

            <div className="ce-nav-foot">
              <div>
                卡片合计 <b>{formatTokens(promptTokens)}</b> tok
              </div>
              {warnCount > 0 && (
                <div className="ce-nav-warn">{warnCount} 个字段不会发出去</div>
              )}
            </div>
          </nav>

          <div className="ce-body" ref={bodyRef} onScroll={onScroll}>
            {fields.map((f) => {
              const { def } = f;
              const wrapTemplate = def.wrap && preset ? preset.formats[def.wrap] : null;
              const previewOpen = openPreview[def.key] ?? false;
              return (
                <section
                  key={def.key}
                  className={`ce-section ${f.status}`}
                  ref={bindSection(def.key)}
                >
                  <div className="ce-sec-head">
                    <span className={`ce-seq ${f.status}`}>
                      {f.seq !== null ? `#${String(f.seq).padStart(2, '0')}` : '—'}
                    </span>
                    <span className="ce-sec-title">{def.label}</span>
                    <div style={{ flex: 1 }} />
                    <span className="ce-sec-target">
                      {def.mode === 'override' ? '覆盖' : '标记位'} {def.target}
                    </span>
                    <span className="ce-sec-token">
                      {f.status === 'active'
                        ? `${formatTokens(f.tokens)} tok`
                        : formatTokens(estimateTokens(f.value))}
                    </span>
                  </div>

                  <div className="ce-sec-hint">{def.hint}</div>

                  {f.status !== 'active' && f.status !== 'empty' && (
                    <div className="ce-sec-warn">{STATUS_NOTE[f.status]}</div>
                  )}

                  <textarea
                    className="ce-textarea"
                    rows={def.rows}
                    value={f.value}
                    placeholder={`（${def.hint}）`}
                    onChange={(e) =>
                      onChange({ [def.key]: e.target.value } as Partial<TavernCard>)
                    }
                  />

                  <div className="ce-sec-foot">
                    {wrapTemplate && (
                      <code className="ce-wrap" title="预设里的包裹模板">
                        {wrapTemplate}
                      </code>
                    )}
                    <div style={{ flex: 1 }} />
                    <button
                      className="ce-preview-toggle"
                      disabled={f.produced.length === 0}
                      onClick={() =>
                        setOpenPreview((m) => ({ ...m, [def.key]: !previewOpen }))
                      }
                    >
                      {f.produced.length === 0
                        ? '无预览'
                        : previewOpen
                          ? '收起预览'
                          : `预览发出去的样子${f.produced.length > 1 ? ` (${f.produced.length} 条)` : ''}`}
                    </button>
                  </div>

                  {previewOpen &&
                    f.produced.map((m, i) => (
                      <div key={i} className="ce-preview">
                        <div className="ce-preview-role">{m.role.toUpperCase()}</div>
                        <pre className="ce-preview-body">{m.content}</pre>
                      </div>
                    ))}
                </section>
              );
            })}

            <div className="ce-divider">
              以下内容不会进入提示词
              <span>开场白进对话,其余只给人看</span>
            </div>

            <section className="ce-section" ref={bindSection('greetings')}>
              <div className="ce-sec-head">
                <span className="ce-seq muted">·</span>
                <span className="ce-sec-title">开场白 · First Message</span>
                <div style={{ flex: 1 }} />
                {greetings.length > 1 && (
                  <span className="greeting-pager">
                    <button
                      className="icon-btn tiny"
                      onClick={() => setGreetingIndex((i) => Math.max(0, i - 1))}
                      disabled={greetingIndex === 0}
                      title="上一条"
                    >
                      ‹
                    </button>
                    <span className="greeting-index">
                      {greetingIndex + 1}/{greetings.length}
                    </span>
                    <button
                      className="icon-btn tiny"
                      onClick={() =>
                        setGreetingIndex((i) => Math.min(greetings.length - 1, i + 1))
                      }
                      disabled={greetingIndex >= greetings.length - 1}
                      title="下一条"
                    >
                      ›
                    </button>
                  </span>
                )}
                <span className="ce-sec-token">
                  {formatTokens(estimateTokens(activeGreeting))}
                </span>
              </div>
              <div className="ce-sec-hint">
                {greetingIndex === 0
                  ? '新建对话时角色说的第一句话'
                  : `其他开场 ${greetingIndex} —— 建对话时可以挑这条`}
              </div>
              <textarea
                className="ce-textarea"
                rows={8}
                value={activeGreeting}
                placeholder="（角色说的第一句话）"
                onChange={(e) => setGreeting(e.target.value)}
              />
              <div className="ce-sec-foot">
                <button
                  className="btn small"
                  onClick={() => {
                    onChange({ alternate_greetings: [...card.alternate_greetings, ''] });
                    setGreetingIndex(greetings.length);
                  }}
                >
                  ＋ 其他开场
                </button>
                {greetingIndex > 0 && (
                  <button
                    className="btn small danger"
                    onClick={() => {
                      onChange({
                        alternate_greetings: card.alternate_greetings.filter(
                          (_, i) => i !== greetingIndex - 1,
                        ),
                      });
                      setGreetingIndex(Math.max(0, greetingIndex - 1));
                    }}
                  >
                    删除这条
                  </button>
                )}
              </div>
            </section>

            <section className="ce-section" ref={bindSection('notes')}>
              <div className="ce-sec-head">
                <span className="ce-seq muted">·</span>
                <span className="ce-sec-title">创作者的注释 · Creator Notes</span>
              </div>
              <div className="ce-sec-hint">给用户看的说明,不会发给 AI</div>
              <textarea
                className="ce-textarea"
                rows={5}
                value={card.creator_notes}
                onChange={(e) => onChange({ creator_notes: e.target.value })}
              />
            </section>

            <section className="ce-section" ref={bindSection('meta')}>
              <div className="ce-sec-head">
                <span className="ce-seq muted">·</span>
                <span className="ce-sec-title">标签 / 元数据</span>
                <div style={{ flex: 1 }} />
                <span className="ce-sec-target">{card.spec || 'spec 未知'}</span>
              </div>
              <div className="ce-meta-row">
                <label className="ce-inline-field">
                  <span>创作者 · Creator</span>
                  <input
                    className="text-input"
                    style={{ maxWidth: 'none' }}
                    value={card.creator}
                    onChange={(e) => onChange({ creator: e.target.value })}
                  />
                </label>
                <label className="ce-inline-field">
                  <span>版本 · Version</span>
                  <input
                    className="text-input"
                    style={{ maxWidth: 'none' }}
                    value={card.character_version}
                    onChange={(e) => onChange({ character_version: e.target.value })}
                  />
                </label>
              </div>
              <label className="ce-inline-field">
                <span>标签 · Tags（逗号分隔）</span>
                <input
                  className="text-input"
                  style={{ maxWidth: 'none' }}
                  value={card.tags.join(', ')}
                  onChange={(e) =>
                    onChange({
                      tags: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </section>

            {card.character_book && (
              <section className="ce-section" ref={bindSection('book')}>
                <div className="ce-sec-head">
                  <span className="ce-seq muted">·</span>
                  <span className="ce-sec-title">角色世界书 · Character Book</span>
                  <div style={{ flex: 1 }} />
                  <span className="ce-sec-token">
                    {card.character_book.entries.length} 条
                  </span>
                </div>
                <div className="ce-sec-hint">
                  目前只读。组装时按 insertion_order 拼进 worldInfo 占位符 ——
                  那部分 token 算在世界书头上,不在上面的卡片合计里
                </div>
                <div className="ce-book">
                  {card.character_book.entries.map((e, i) => (
                    <div key={i} className={`ce-book-row${e.enabled ? '' : ' off'}`}>
                      <span className="ce-book-order">{e.insertion_order}</span>
                      <span className="ce-book-keys">
                        {e.keys.join(', ') || e.comment || '(无关键词)'}
                      </span>
                      <span className="ce-book-token">
                        {formatTokens(estimateTokens(e.content))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* 右缘竖排小条:点开向右展开整个提示词的 token 分布 */}
          <button
            className={`ce-tok-toggle${showTokens ? ' active' : ''}`}
            onClick={() => setShowTokens((v) => !v)}
            title="Token 分布 —— 整个提示词各部分占多少"
          >
            {showTokens ? '▸' : '◂'} TOKEN
          </button>
          {showTokens && <TokenRail report={result.budget} budget={budget} />}
        </div>
      </div>
    </div>
  );
}

/** 上下文预算条的竖版:同一份 report,横条看占比,这条改看纵向堆叠 */
function TokenRail({ report, budget }: { report: BudgetReport; budget: number | null }) {
  // 自上而下的堆叠顺序对齐横条的「固定开销在前、历史殿后」
  const parts: { key: PromptPart; name: string; tokens: number }[] = [
    { key: 'preset', name: '预设', tokens: report.parts.preset },
    { key: 'persona', name: '玩家人设', tokens: report.parts.persona },
    { key: 'card', name: '角色卡', tokens: report.parts.card },
    { key: 'examples', name: '示例对话', tokens: report.parts.examples },
    { key: 'worldInfo', name: '世界书', tokens: report.parts.worldInfo },
    { key: 'history', name: '历史', tokens: report.parts.history },
  ];

  const total = report.fixedTokens + report.historyTokens;
  // 满刻度:有预算用预算(条就是「预算用了多少」),没预算就用总量(条永远满)
  const scale = Math.max(total, budget ?? 0, 1);
  const pct = (n: number) => Math.min(100, (n / scale) * 100);

  return (
    <aside className="ce-tok-panel">
      <div className="ce-tok-head">
        <span className="ce-tok-title">Token 分布</span>
        <span className="ce-tok-sub">{budget === null ? '不截断' : `预算 ${formatTokens(budget)}`}</span>
      </div>

      <div className="ce-tok-body">
        <div className={`ce-tok-bar${report.overflow ? ' overflow' : ''}`}>
          {parts
            .filter((p) => p.tokens > 0)
            .map((p) => (
              <div
                key={p.key}
                className={`ce-tok-seg ${p.key}`}
                style={{ height: `${pct(p.tokens)}%` }}
                title={`${p.name} ${formatTokens(p.tokens)}`}
              />
            ))}
          {/* 固定开销的终点:线以下是历史 */}
          <div
            className="ce-tok-tick"
            style={{ top: `${pct(report.fixedTokens)}%` }}
            title="固定开销到此为止,线以下是历史"
          />
          {budget !== null && (
            <div className="ce-tok-limit" style={{ top: `${pct(budget)}%` }} title="预算线" />
          )}
        </div>

        <div className="ce-tok-legend">
          {parts.map((p) => (
            <div key={p.key} className="ce-tok-legend-row">
              <span className={`ce-tok-swatch ${p.key}`} />
              <span className="ce-tok-legend-name">{p.name}</span>
              <span className="ce-tok-legend-tokens">{formatTokens(p.tokens)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="ce-tok-foot">
        <div>
          合计 <b>{formatTokens(total)}</b>
          {budget !== null && ` / ${formatTokens(budget)}`}
        </div>
        <div className={report.droppedCount > 0 ? 'ce-tok-warn' : 'ce-tok-dim'}>
          {budget === null
            ? '截断关闭'
            : report.droppedCount > 0
              ? `截断 ${report.droppedCount} 条 / ${formatTokens(report.droppedTokens)}`
              : '无截断'}
        </div>
        {report.overflow && <div className="ce-tok-warn">固定开销已超预算 —— 历史一条都放不下</div>}
        {!report.overflow && report.forcedLastMessage && (
          <div className="ce-tok-warn">最后一条消息单独就超预算</div>
        )}
      </div>
    </aside>
  );
}
