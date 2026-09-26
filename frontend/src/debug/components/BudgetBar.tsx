import { useEffect, useRef, useState } from 'react';
import type { BudgetReport } from '../lib/assembler';
import { RANGE_STEPS, stepRange } from '../lib/budget';
import { formatTokens } from '../lib/tokens';

interface Props {
  report: BudgetReport;
  /** 当前预算。null = 不截断 */
  value: number | null;
  onChange: (v: number | null) => void;
  /** 轨道满刻度 */
  range: number;
  onRange: (r: number) => void;
}

const MIN_BUDGET = 256;
const MAX_BUDGET = 2_000_000;

/** 占满刻度的百分比,超过量程就钉在 100 —— 轨道不撑破 */
const pct = (n: number, range: number) => Math.min(100, (n / range) * 100);

export function BudgetBar({ report, value, onChange, range, onRange }: Props) {
  const [open, setOpen] = useState(false);
  // 输入框里的草稿:聚焦期间不被外部值覆盖,免得打字打到一半被弹回去
  const [text, setText] = useState(value === null ? '' : String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value === null ? '' : String(value));
  }, [value]);

  const commit = () => {
    focused.current = false;
    const t = text.trim();
    if (t === '' || t === '0') {
      onChange(null); // 逃生门:关掉截断
      return;
    }
    const n = Number(t.replace(/[,_\s]/g, ''));
    if (Number.isFinite(n) && n >= MIN_BUDGET) {
      onChange(Math.min(MAX_BUDGET, Math.floor(n)));
    } else {
      setText(value === null ? '' : String(value)); // 非法输入弹回原值
    }
  };

  const sum = report.fixedTokens + report.historyTokens;

  const legendRow = (cls: string, name: string, tokens: number) => (
    <div className="budget-legend-row" key={cls}>
      <span className={`budget-swatch ${cls}`} />
      <span className="budget-legend-name">{name}</span>
      <span className="budget-legend-tokens">{tokens ? formatTokens(tokens) : '0'}</span>
    </div>
  );

  const detailRow = (name: string, tokens: number) => (
    <div className="budget-detail-row" key={name}>
      <span className="budget-detail-name">{name}</span>
      <span className="budget-detail-tokens">{tokens ? formatTokens(tokens) : '0'}</span>
    </div>
  );

  return (
    <div
      className={`budget-bar${report.overflow ? ' overflow' : ''}${value === null ? ' off' : ''}`}
    >
      <div className="budget-head">
        <span className="budget-label">上下文预算</span>
        <input
          className="budget-input"
          type="text"
          inputMode="numeric"
          value={text}
          placeholder="关"
          title="整个提示词的 token 上限。0 或清空 = 不截断"
          onChange={(e) => setText(e.target.value)}
          onFocus={() => (focused.current = true)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setText(value === null ? '' : String(value));
              e.currentTarget.blur();
            }
          }}
        />
        <button className="budget-more" onClick={() => setOpen((v) => !v)}>
          {open ? '▴ 收起' : '⌄ 更多'}
        </button>
      </div>

      <div className="budget-track">
        <div className="budget-fill">
          <div className="budget-seg preset" style={{ width: `${pct(report.presetTokens, range)}%` }} />
          <div className="budget-seg card" style={{ width: `${pct(report.cardTokens, range)}%` }} />
          <div
            className="budget-seg history"
            style={{ width: `${pct(report.historyTokens, range)}%` }}
          />
        </div>
        {/* 那条「线」:固定开销的终点。段窄到看不清色相切换时靠它定位 */}
        <div className="budget-tick" style={{ left: `${pct(report.fixedTokens, range)}%` }} />
        {value !== null && (
          <div className="budget-handle" style={{ left: `${pct(value, range)}%` }} />
        )}
        {value !== null && (
          <input
            className="budget-slider"
            type="range"
            min={MIN_BUDGET}
            max={range}
            step={64}
            value={Math.min(value, range)}
            onChange={(e) => onChange(Number(e.target.value))}
            title="拖动调整预算"
          />
        )}
        <span className="budget-scale-min">0</span>
        <span className="budget-scale-max">{formatTokens(range)}</span>
      </div>

      <div className="budget-legend">
        <div className="budget-legend-rows">
          {legendRow('preset', '预设', report.presetTokens)}
          {legendRow('card', '角色卡', report.cardTokens)}
          {legendRow('history', '历史', report.historyTokens)}
        </div>
        <div className="budget-sums">
          <div className={`budget-sum${report.forcedLastMessage ? ' danger' : ''}`}>
            合计 {formatTokens(sum)}
            {value !== null ? ` / ${formatTokens(value)}` : ''}
          </div>
          <div className="budget-dropped">
            {value === null
              ? '截断关闭'
              : report.droppedCount > 0
                ? `截断 ${report.droppedCount} 条 / ${formatTokens(report.droppedTokens)}`
                : '无截断'}
          </div>
        </div>
      </div>

      {report.overflow && (
        <div className="budget-notice danger">固定开销已超预算 —— 历史一条都放不下</div>
      )}
      {!report.overflow && report.forcedLastMessage && (
        <div className="budget-notice danger">最后一条消息单独就超预算</div>
      )}

      {open && (
        <div className="budget-detail">
          <div className="budget-range-row">
            <span className="budget-detail-name">量程</span>
            <button
              className="icon-btn tiny"
              onClick={() => onRange(stepRange(range, -1))}
              disabled={range === RANGE_STEPS[0]}
              title="缩小量程 —— 固定段会被放大看"
            >
              −
            </button>
            <span className="budget-range-value">{formatTokens(range)}</span>
            <button
              className="icon-btn tiny"
              onClick={() => onRange(stepRange(range, 1))}
              disabled={range === RANGE_STEPS[RANGE_STEPS.length - 1]}
              title="放大量程"
            >
              +
            </button>
          </div>
          <div className="budget-detail-grid">
            {detailRow('预设', report.parts.preset)}
            {detailRow('角色卡', report.parts.card)}
            {detailRow('玩家人设', report.parts.persona)}
            {detailRow('示例对话', report.parts.examples)}
            {detailRow('世界书', report.parts.worldInfo)}
            {detailRow('历史(进提示词的)', report.parts.history)}
            <div className="budget-detail-row dropped">
              <span className="budget-detail-name">截断</span>
              <span className="budget-detail-tokens">
                {value === null
                  ? '关闭'
                  : report.droppedCount > 0
                    ? `${report.droppedCount} 条 / ${formatTokens(report.droppedTokens)}`
                    : '无'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
