import { useState } from 'react';
import type { AssemblyResult } from '../lib/assembler';
import { findUnresolvedMacros } from '../lib/macros';
import { formatTokens } from '../lib/tokens';

interface Props {
  result: AssemblyResult;
  /** 最近一次请求的原始返回,没有就是 null */
  lastRaw: string | null;
  onClose: () => void;
  onNotify: (kind: 'ok' | 'error', message: string) => void;
}

type Tab = 'messages' | 'json' | 'skipped';

export function PromptInspector({ result, lastRaw, onClose, onNotify }: Props) {
  const [tab, setTab] = useState<Tab>('messages');

  const payload = result.messages.map((m) => ({ role: m.role, content: m.content }));
  const unresolved = [
    ...new Set(result.messages.flatMap((m) => findUnresolvedMacros(m.content))),
  ];

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify('ok', `已复制${what}`);
    } catch {
      onNotify('error', '复制失败 —— 浏览器拒绝了剪贴板访问');
    }
  };

  return (
    <div className="inspector-backdrop" onClick={onClose}>
      <div className="inspector" onClick={(e) => e.stopPropagation()}>
        <div className="inspector-head">
          <span className="inspector-title">完整提示词 · Full Prompt</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn small"
            onClick={() => copy(JSON.stringify(payload, null, 2), ' JSON')}
          >
            复制 JSON
          </button>
          <button
            className="btn small"
            onClick={() =>
              copy(
                result.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n'),
                '纯文本',
              )
            }
          >
            复制文本
          </button>
          <button className="btn small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="inspector-tabs">
          <button
            className={`inspector-tab ${tab === 'messages' ? 'active' : ''}`}
            onClick={() => setTab('messages')}
          >
            消息 ({result.messages.length})
          </button>
          <button
            className={`inspector-tab ${tab === 'json' ? 'active' : ''}`}
            onClick={() => setTab('json')}
          >
            JSON
          </button>
          <button
            className={`inspector-tab ${tab === 'skipped' ? 'active' : ''}`}
            onClick={() => setTab('skipped')}
          >
            被跳过 ({result.skipped.length})
          </button>
          {lastRaw !== null && (
            <button
              className={`inspector-tab ${tab === ('raw' as Tab) ? 'active' : ''}`}
              onClick={() => setTab('raw' as Tab)}
            >
              原始返回
            </button>
          )}
        </div>

        <div className="inspector-body">
          <div className="inspector-summary">
            <span className="summary-chip">
              消息 <b>{result.messages.length}</b>
            </span>
            <span className="summary-chip">
              约 <b>{formatTokens(result.totalTokens)}</b> tokens
            </span>
            <span className="summary-chip">
              system{' '}
              <b>{result.messages.filter((m) => m.role === 'system').length}</b>
            </span>
            <span className="summary-chip">
              历史 <b>{result.messages.filter((m) => m.sourceKind === 'history').length}</b>
            </span>
            {result.budget.droppedCount > 0 && (
              <span className="summary-chip warn">
                截断 <b>{result.budget.droppedCount}</b> 条 /{' '}
                {formatTokens(result.budget.droppedTokens)}
              </span>
            )}
            {result.danglingIdentifiers.length > 0 && (
              <span className="summary-chip warn">
                悬空引用 <b>{result.danglingIdentifiers.length}</b>
              </span>
            )}
            {unresolved.length > 0 && (
              <span className="summary-chip warn">
                未解析宏 <b>{unresolved.length}</b>
              </span>
            )}
          </div>

          {unresolved.length > 0 && tab === 'messages' && (
            <div className="notice">
              这些宏没有被解析,会原样发给模型:{' '}
              <span style={{ fontFamily: 'var(--mono)' }}>{unresolved.join('  ')}</span>
            </div>
          )}

          {tab === 'messages' &&
            result.messages.map((m, i) => (
              <div key={i} className="imsg">
                <div className="imsg-head">
                  <span className="imsg-index">{String(i).padStart(2, '0')}</span>
                  <span className={`imsg-role ${m.role}`}>{m.role.toUpperCase()}</span>
                  <span className="imsg-source" title={m.sourceIdentifier}>
                    {m.sourceName}
                  </span>
                  <span className="imsg-kind">{m.sourceKind}</span>
                  <span className="imsg-tokens">{formatTokens(m.tokens)}</span>
                </div>
                <pre className="imsg-body">{m.content}</pre>
              </div>
            ))}

          {tab === 'json' && (
            <pre className="raw-view">{JSON.stringify(payload, null, 2)}</pre>
          )}

          {tab === 'skipped' && (
            <>
              {result.skipped.length === 0 && (
                <div className="panel-empty">没有块被跳过</div>
              )}
              {result.skipped.map((s, i) => (
                <div key={`${s.identifier}:${i}`} className="skip-row">
                  <span style={{ color: 'var(--text-dim)' }}>{s.name}</span>
                  <span className="skip-reason">{s.reason}</span>
                </div>
              ))}
            </>
          )}

          {(tab as string) === 'raw' && (
            <pre className="raw-view">{lastRaw ?? '(还没有发过请求)'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
