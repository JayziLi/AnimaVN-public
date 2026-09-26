import { useCallback, useEffect, useState } from 'react';
import {
  debugApi,
  type ApiType,
  type DebugConnection,
} from '../lib/api';

/** 与游戏版 ConnectionsPanel 同一份逻辑(增删改/选中即激活/两步删除/
 *  模型刷新与未保存预览/ping/测试消息),只是换成控制台顶部的抽屉式呈现 */

const BASE_URL_HINTS: Record<ApiType, string> = {
  openai_compatible: 'https://api.openai.com/v1 · OpenRouter / Ollama 等兼容地址',
  anthropic: '留空使用官方 API',
  mock: '无需填写',
};

const DEFAULT_TEST_MESSAGE = 'Hi! Reply with one short sentence.';

interface Props {
  /** 外层(顶栏)手里的连接列表 —— 顶栏切连接/换模型后抽屉靠它跟上 */
  connections: DebugConnection[];
  notify: (kind: 'ok' | 'error', message: string) => void;
  onClose: () => void;
  /** 连接变化(增删改/启用)后通知外层刷新它自己的连接状态 */
  onChanged: () => void;
}

interface FormState {
  name: string;
  api_type: ApiType;
  base_url: string;
  api_key: string;
  model: string;
  stream: boolean;
}

type Busy = 'save' | 'delete' | 'refresh' | 'ping' | 'test' | null;

function formFrom(conn: DebugConnection | null): FormState {
  return {
    name: conn?.name ?? '',
    api_type: (conn?.api_type as ApiType) ?? 'openai_compatible',
    base_url: conn?.base_url ?? '',
    api_key: '',
    model: conn?.model ?? '',
    stream: conn?.stream ?? true,
  };
}

export function ConnectionsDrawer({ connections: shared, notify, onClose, onChanged }: Props) {
  const [connections, setConnections] = useState<DebugConnection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => formFrom(null));
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState(DEFAULT_TEST_MESSAGE);
  const [busy, setBusy] = useState<Busy>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const selected = connections?.find((c) => c.id === selectedId) ?? null;
  const active = connections?.find((c) => c.is_active) ?? null;

  const reload = useCallback(async (keepId?: string | null) => {
    const list = await debugApi.listConnections();
    setConnections(list);
    const target =
      (keepId && list.find((c) => c.id === keepId)) ?? list.find((c) => c.is_active) ?? list[0];
    if (target) {
      setSelectedId(target.id);
      setForm(formFrom(target));
      setCachedModels(target.cached_models ?? []);
    } else {
      setSelectedId(null);
      setForm(formFrom(null));
      setCachedModels([]);
    }
  }, []);

  useEffect(() => {
    reload().catch((e: unknown) => notify('error', e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 顶栏的「连接」「模型」下拉改的是同一份后端数据:外层列表一变就换成它。
  // 正在看的那条如果模型被顶栏改了,表单里的模型名跟过去,其它没保存的编辑不动
  useEffect(() => {
    if (shared.length === 0) return;
    const prev = connections?.find((c) => c.id === selectedId);
    const next = shared.find((c) => c.id === selectedId);
    if (prev && next) {
      if (next.model !== prev.model) setForm((f) => ({ ...f, model: next.model }));
      setCachedModels(next.cached_models ?? []);
    }
    setConnections(shared);
    // 只跟外层列表走;connections/selectedId 读的是本次渲染的最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared]);

  const selectConnection = async (id: string) => {
    const conn = connections?.find((c) => c.id === id);
    if (!conn) return;
    setSelectedId(id);
    setForm(formFrom(conn));
    setCachedModels(conn.cached_models ?? []);
    setDeleteArmed(false);
    // 和游戏版一致:在列表里选中一条非启用的连接 = 把它设为当前启用
    if (!conn.is_active) {
      try {
        await debugApi.activateConnection(id);
        await reload(id);
        onChanged();
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e));
      }
    }
  };

  const startNew = () => {
    setSelectedId(null);
    setForm(formFrom(null));
    setCachedModels([]);
    setDeleteArmed(false);
  };

  const save = async () => {
    if (!form.name.trim()) {
      notify('error', '请填写连接名称');
      return;
    }
    setBusy('save');
    try {
      let savedId = selectedId;
      if (selectedId && selected) {
        // 只提交变化了的字段;密钥留空 = 保持已保存的不变
        const patch: Partial<FormState> = {};
        if (form.name !== selected.name) patch.name = form.name;
        if (form.api_type !== selected.api_type) patch.api_type = form.api_type;
        if (form.base_url !== (selected.base_url ?? '')) patch.base_url = form.base_url;
        if (form.model !== selected.model) patch.model = form.model;
        if (form.stream !== selected.stream) patch.stream = form.stream;
        if (form.api_key.trim()) patch.api_key = form.api_key.trim();
        if (Object.keys(patch).length > 0) {
          await debugApi.updateConnection(selectedId, patch);
        }
      } else {
        const created = await debugApi.createConnection({
          name: form.name.trim(),
          api_type: form.api_type,
          base_url: form.base_url || null,
          api_key: form.api_key.trim() || null,
          model: form.model,
          stream: form.stream,
        });
        savedId = created.id;
        await debugApi.activateConnection(created.id);
      }
      await reload(savedId);
      onChanged();
      notify('ok', '已保存');
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    // 两步确认,和游戏版一致
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setBusy('delete');
    try {
      await debugApi.deleteConnection(selectedId);
      setDeleteArmed(false);
      await reload();
      onChanged();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshModels = async () => {
    setBusy('refresh');
    try {
      if (selectedId) {
        const models = await debugApi.refreshConnectionModels(selectedId);
        setCachedModels(models);
        setConnections((prev) =>
          prev
            ? prev.map((c) => (c.id === selectedId ? { ...c, cached_models: models } : c))
            : prev,
        );
        onChanged();
      } else {
        // 还没保存的表单也能拉模型列表(预览接口,用表单里的密钥)
        const models = await debugApi.previewConnectionModels({
          api_type: form.api_type,
          base_url: form.base_url || null,
          api_key: form.api_key.trim() || null,
          connection_id: null,
        });
        setCachedModels(models);
      }
      notify('ok', '模型列表已刷新');
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** 从列表选模型 = 立刻存进连接,顶栏「模型」读的是同一个字段。新建中的连接只填表单 */
  const pickModel = async (model: string) => {
    setForm((f) => ({ ...f, model }));
    if (!selectedId) return;
    try {
      await debugApi.updateConnection(selectedId, { model });
      setConnections((prev) =>
        prev ? prev.map((c) => (c.id === selectedId ? { ...c, model } : c)) : prev,
      );
      onChanged();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    }
  };

  const ping = async () => {
    if (!selectedId) return;
    setBusy('ping');
    try {
      const result = await debugApi.pingConnection(selectedId);
      notify(result.ok ? 'ok' : 'error', result.message);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const sendTestMessage = async () => {
    if (!selectedId) return;
    setBusy('test');
    try {
      const result = await debugApi.testConnectionMessage(selectedId, testMessage);
      notify('ok', result.reply);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="conn-drawer">
      <div className="conn-drawer-head">
        <span className="conn-drawer-title">API · 连接管理</span>
        <span className="conn-drawer-sub">与游戏内「连接设置」同一份数据,改动互通</span>
        <div style={{ flex: 1 }} />
        {active && (
          <span className="conn-active-chip">
            <span className="dot on" /> {active.name} · {active.model || '未设模型'}
          </span>
        )}
        <button className="panel-collapse" onClick={onClose} title="收起">
          ✕
        </button>
      </div>

      <div className="conn-drawer-body">
        <div className="conn-main">
          <label className="conn-field">
            <span className="conn-label">已保存的连接 · SAVED</span>
            <div className="conn-row">
              <select
                className="select conn-select"
                value={selectedId ?? ''}
                onChange={(e) => (e.target.value ? selectConnection(e.target.value) : startNew())}
                disabled={busy !== null}
              >
                <option value="">＋ 新建连接…</option>
                {connections?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_active ? '（当前启用）' : ''}
                  </option>
                ))}
              </select>
              <button className="btn small" onClick={startNew} disabled={busy !== null}>
                新建
              </button>
              <button className="btn small accent" onClick={save} disabled={busy !== null}>
                {busy === 'save' && <span className="spinner" />}
                {busy === 'save' ? '保存中…' : '保存'}
              </button>
              {selectedId && (
                <button
                  className={`btn small danger${deleteArmed ? ' armed' : ''}`}
                  onClick={remove}
                  disabled={busy !== null}
                >
                  {busy === 'delete' ? '删除中…' : deleteArmed ? '确认删除?' : '删除'}
                </button>
              )}
            </div>
          </label>

          <div className="conn-grid">
            <label className="conn-field">
              <span className="conn-label">名称 · NAME</span>
              <input
                className="text-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例:OpenRouter / 本地 Ollama"
              />
            </label>
            <label className="conn-field">
              <span className="conn-label">类型 · API TYPE</span>
              <select
                className="select"
                value={form.api_type}
                onChange={(e) => setForm((f) => ({ ...f, api_type: e.target.value as ApiType }))}
              >
                <option value="openai_compatible">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
                <option value="mock">Mock(本地测试)</option>
              </select>
            </label>

            {form.api_type !== 'mock' && (
              <>
                <label className="conn-field span-2">
                  <span className="conn-label">BASE URL</span>
                  <input
                    className="text-input"
                    value={form.base_url}
                    onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                    placeholder={BASE_URL_HINTS[form.api_type]}
                  />
                </label>
                <label className="conn-field span-2">
                  <span className="conn-label">API KEY</span>
                  <input
                    className="text-input"
                    type="password"
                    value={form.api_key}
                    onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
                    placeholder={selected?.has_api_key ? '已保存密钥(留空保持不变)' : 'sk-…'}
                    autoComplete="new-password"
                  />
                </label>
              </>
            )}

            <label className="conn-field span-2">
              <span className="conn-label">模型名 · MODEL</span>
              <div className="conn-row">
                <input
                  className="text-input conn-model-input"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder="例:claude-sonnet-5 / gpt-4o / llama3"
                />
                {form.api_type !== 'mock' && (
                  <button className="btn small" onClick={refreshModels} disabled={busy !== null}>
                    {busy === 'refresh' && <span className="spinner" />}
                    {busy === 'refresh' ? '刷新中…' : '刷新列表'}
                  </button>
                )}
              </div>
            </label>

            {/* 流式是端点的能力,不是我们的偏好 —— 所以开关跟着连接走 */}
            <label className="conn-field span-2 conn-switch">
              <input
                type="checkbox"
                checked={form.stream}
                onChange={(e) => setForm((f) => ({ ...f, stream: e.target.checked }))}
              />
              <span>
                <span className="conn-label">流式输出 · STREAMING</span>
                <span className="conn-switch-hint">
                  边生成边显示，思维链单独渲染。有些中转站不吃 stream=true，报错就关掉它。
                </span>
              </span>
            </label>

            {cachedModels.length > 0 && (
              <label className="conn-field span-2">
                <span className="conn-label">可用模型 · {cachedModels.length} 个</span>
                <select
                  className="select"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) pickModel(e.target.value);
                  }}
                >
                  <option value="">从列表选择…</option>
                  {cachedModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {selected && form.api_key === '' && selected.has_api_key && (
            <div className="conn-note">密钥已保存在后端,不会回传明文;留空则继续使用。</div>
          )}
        </div>

        <div className="conn-side">
          <label className="conn-field">
            <span className="conn-label">测试消息 · TEST MESSAGE</span>
            <textarea
              className="conn-textarea"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              rows={3}
            />
          </label>
          <div className="conn-side-actions">
            <button
              className="btn accent"
              onClick={ping}
              disabled={!selectedId || busy !== null}
            >
              {busy === 'ping' && <span className="spinner" />}
              {busy === 'ping' ? '连接中…' : '连接'}
            </button>
            <button
              className="btn"
              onClick={sendTestMessage}
              disabled={!selectedId || busy !== null || !testMessage.trim()}
            >
              {busy === 'test' && <span className="spinner" />}
              {busy === 'test' ? '发送中…' : '发送测试消息'}
            </button>
          </div>
          {selectedId === null && (
            <div className="conn-note">先在左侧选中或保存一条连接,才能测试连通性。</div>
          )}
        </div>
      </div>
    </div>
  );
}
