/** 插件抽屉几页共用的两个表单小件 */

import { useEffect, useState } from 'react';

/** 两次点击才生效的删除按钮 */
export function DeleteButton({
  disabled,
  onConfirm,
  label = '删除',
}: {
  disabled: boolean;
  onConfirm: () => void;
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={`btn small danger${armed ? ' armed' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? '确认删除' : label}
    </button>
  );
}

/** 失焦或回车时才提交;后端拒绝(比如重名)时把输入框恢复成原值 */
export function CommitField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = async () => {
    if (draft.trim() === value.trim()) {
      setDraft(value);
      return;
    }
    if (!(await onCommit(draft.trim()))) setDraft(value);
  };

  return (
    <label className="pl-field">
      <span className="conn-label">{label}</span>
      <input
        className="text-input"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}
