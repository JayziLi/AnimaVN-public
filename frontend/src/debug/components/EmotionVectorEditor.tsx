/**
 * IndexTTS 的 8 维情绪向量:8 个小数字框,旁边是合计。焦点离开整个编辑器(或按回车)时
 * 整条保存;超出范围就标红、不保存。全 0 等于不控制,存成空。
 */

import { useState } from 'react';
import { EMO_DIM_MAX, EMO_DIMS, EMO_SUM_MAX, emoVectorProblem } from '../plugins/voice';

const ZERO: number[] = EMO_DIMS.map(() => 0);

export function EmotionVectorEditor({
  value,
  disabled,
  onCommit,
}: {
  value: number[] | null;
  /** 这一行填了情绪参考:向量不生效,变灰但还能改 */
  disabled?: boolean;
  onCommit: (v: number[] | null) => Promise<boolean>;
}) {
  const saved = value ?? ZERO;
  const [draft, setDraft] = useState<string[] | null>(null);
  const shown = draft ?? saved.map((n) => String(n));
  const nums = shown.map((s) => (s.trim() === '' ? 0 : Number(s)));
  const problem = emoVectorProblem(nums);
  const total = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  const commit = async () => {
    if (draft === null || problem) return;
    if (nums.some((n, i) => n !== saved[i])) {
      if (!(await onCommit(nums.some((n) => n > 0) ? nums : null))) return;
    }
    setDraft(null);
  };

  return (
    <div
      className={`vp-vector${disabled ? ' off' : ''}`}
      onBlur={(e) => {
        // 在 8 个框之间切换不算离开
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void commit();
      }}
    >
      <span className="conn-label">情绪向量</span>
      <div className="vp-vector-cells">
        {EMO_DIMS.map((d, i) => (
          <label key={d.name} className="vp-vector-cell" title={d.name}>
            <span>{d.short}</span>
            <input
              className="text-input"
              type="number"
              inputMode="decimal"
              min={0}
              max={EMO_DIM_MAX}
              step={0.1}
              value={shown[i]}
              onChange={(e) => {
                const next = [...shown];
                next[i] = e.target.value;
                setDraft(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commit();
                if (e.key === 'Escape') setDraft(null);
              }}
            />
          </label>
        ))}
      </div>
      <span className={`sp-group-note${problem ? ' vp-bad' : ''}`}>
        {problem ?? `合计 ${total.toFixed(1)} / ${EMO_SUM_MAX}`}
        {disabled && ' · 已填情绪参考,向量不生效'}
      </span>
    </div>
  );
}
