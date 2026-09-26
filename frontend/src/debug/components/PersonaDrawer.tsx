import { useCallback, useEffect, useState } from 'react';
import { debugApi, type DebugPersona } from '../lib/api';
import { avatarOf } from '../lib/avatar';
import { bindCard, forgetPersona, type PersonaBindings } from '../lib/personaBinding';

interface Props {
  notify: (kind: 'ok' | 'error', message: string) => void;
  onClose: () => void;
  /** 人设增删改/切换后通知外层重新拉取并套用到组装 */
  onChanged: () => void;
  /** 换头像走外层那套「选文件 → 裁剪 → 写回」,弹窗只有一个 */
  onPickAvatar: (personaId: string) => void;
  /** 人设绑角色卡:选卡时自动切过去(见 lib/personaBinding.ts) */
  bindings: PersonaBindings;
  onChangeBindings: (next: PersonaBindings) => void;
  /** 当前选中的角色卡,「绑定到这张卡」用;没选卡是 null */
  card: { id: string; name: string } | null;
  /** 角色卡 id → 名字,列出一个人设绑了哪些卡 */
  cardNames: ReadonlyMap<string, string>;
}

/**
 * 玩家人设面板 —— 复刻酒馆的 Persona Management:人设是全局的一份清单,
 * 激活的那个决定提示词里 {{user}} 是谁、personaDescription 填什么。
 *
 * 选身份、改名字描述、换头像都在这一个面板里做完;
 * 顶栏只留一颗「玩家」小按钮开它 —— 这功能不常动,不值得占常驻位置。
 */
export function PersonaDrawer({
  notify,
  onClose,
  onChanged,
  onPickAvatar,
  bindings,
  onChangeBindings,
  card,
  cardNames,
}: Props) {
  const [personas, setPersonas] = useState<DebugPersona[] | null>(null);
  /** 正在编辑哪个;null 且 creating 为 false = 只看列表 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const fail = (e: unknown) => notify('error', e instanceof Error ? e.message : String(e));

  const reload = useCallback(async () => {
    const list = await debugApi.listPersonas();
    setPersonas(list);
    return list;
  }, []);

  /** 把某个人设装进下方表单 —— 选中即展开详情,不用再点一次「编辑」 */
  const loadForm = (p: DebugPersona) => {
    setEditingId(p.id);
    setCreating(false);
    setName(p.name);
    setDescription(p.description);
    setArmed(false);
  };

  // 一打开就停在当前启用的人设上:面板的常见用途是「看看我现在是谁、顺手改两笔」
  useEffect(() => {
    reload()
      .then((list) => {
        const p = list.find((x) => x.is_active) ?? list[0];
        if (p) loadForm(p);
      })
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelCreate = () => {
    setCreating(false);
    setArmed(false);
    // 退回到当前启用的那个,别把表单留空
    const p = personas?.find((x) => x.is_active) ?? personas?.[0];
    if (p) loadForm(p);
    else setEditingId(null);
  };

  const startNew = () => {
    setEditingId(null);
    setCreating(true);
    setName('');
    setDescription('');
    setArmed(false);
  };

  /** 点一行 = 启用它 + 把它装进表单。选身份和看详情是同一个动作 */
  const pick = async (p: DebugPersona) => {
    loadForm(p);
    if (p.is_active) return;
    setBusy(true);
    try {
      await debugApi.activatePersona(p.id);
      await reload();
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      notify('error', '人设名字不能为空');
      return;
    }
    setBusy(true);
    try {
      if (editingId) {
        // 只发改动过的字段,和连接抽屉一个路子
        const target = personas?.find((p) => p.id === editingId);
        const patch: { name?: string; description?: string } = {};
        if (target && trimmed !== target.name) patch.name = trimmed;
        if (target && description !== target.description) patch.description = description;
        if (Object.keys(patch).length > 0) await debugApi.updatePersona(editingId, patch);
        notify('ok', '人设已保存');
      } else {
        const created = await debugApi.createPersona({ name: trimmed, description });
        // 新建的直接启用 —— 建它就是为了用它
        await debugApi.activatePersona(created.id);
        setEditingId(created.id);
        setCreating(false);
        notify('ok', `人设「${created.name}」已创建并启用`);
      }
      await reload();
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editingId) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await debugApi.deletePersona(editingId);
      // 指向它的绑定和默认一起清掉
      const cleaned = forgetPersona(bindings, editingId);
      if (JSON.stringify(cleaned) !== JSON.stringify(bindings)) onChangeBindings(cleaned);
      setArmed(false);
      const list = await reload();
      // 删完顺势停在还剩下的那个上,表单不留空白
      const next = list.find((x) => x.is_active) ?? list[0];
      if (next) loadForm(next);
      else {
        setEditingId(null);
        setCreating(false);
      }
      onChanged();
      notify('ok', '人设已删除');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 把当前这张卡绑到正在看的人设上(取消勾选是解绑)。绑上就顺手启用它 —— 这张卡现在就该用它
   */
  const bindHere = async (on: boolean) => {
    if (!card || !editingId) return;
    onChangeBindings(bindCard(bindings, card.id, on ? editingId : null));
    const target = personas?.find((p) => p.id === editingId);
    if (on && target && !target.is_active) await pick(target);
  };

  const active = personas?.find((p) => p.is_active) ?? null;
  const editing = personas?.find((p) => p.id === editingId) ?? null;
  // 正在看的人设绑了哪些卡(同名的卡合在一起数)
  const boundNames = (() => {
    const count = new Map<string, number>();
    for (const [cid, pid] of Object.entries(bindings.cards)) {
      if (pid !== editingId) continue;
      const n = cardNames.get(cid) ?? '(已删除的卡)';
      count.set(n, (count.get(n) ?? 0) + 1);
    }
    return [...count].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join('、');
  })();
  const formOpen = creating || editingId !== null;
  const dirty =
    editing !== null && (name.trim() !== editing.name || description !== editing.description);

  return (
    <div className="conn-drawer">
      <div className="conn-drawer-head">
        <span className="conn-drawer-title">PLAYER · 玩家人设</span>
        <button
          className={`persona-help-btn${showHelp ? ' on' : ''}`}
          onClick={() => setShowHelp((v) => !v)}
          title="这是干什么用的?"
        >
          ?
        </button>
        <div style={{ flex: 1 }} />
        {active && (
          <span className="conn-active-chip">
            <img className="persona-chip-avatar" src={avatarOf(active)} alt="" />
            {active.name}
          </span>
        )}
        <button className="panel-collapse" onClick={onClose} title="收起">
          ✕
        </button>
      </div>

      {showHelp && (
        <div className="persona-help">
          <p>
            <b>人设 = 你在故事里是谁。</b>
            全局一份清单,同一时刻只启用一个;点列表里的一行就是换身份,换完立刻影响下一次请求。
          </p>
          <p>
            <b>名字</b>会替换提示词里所有 <code>{'{{user}}'}</code> 宏 —— 角色卡描述、开场白、预设块里的都算。
          </p>
          <p>
            <b>描述</b>填进预设的 <code>personaDescription</code> 块(左栏那行「玩家人设」)。它在提示词里的位置由预设编排决定:想挪就在左栏拖那一行,把它关掉描述就完全不进提示词。
          </p>
          <p>
            <b>头像</b>只在调试台里显示,不进提示词,也不占 token。
          </p>
          <p>
            <b>绑定角色卡</b>:在人设详情里勾「绑定到当前角色卡」,以后选这张卡就自动换成这个人设(比如玩某部作品的卡时用原作主角的身份);
            再给常用的人设勾上「默认人设」,选其他没绑的卡时就自动换回来。
          </p>
          <p className="persona-help-dim">
            一个人设都没有(或全删了)时,{'{{user}}'} 回退成「User」,空的描述块会被自动跳过。
          </p>
        </div>
      )}

      <div className="conn-drawer-body">
        <div className="conn-main">
          <div className="persona-list-head">
            <span className="conn-label">人设列表 · 点击启用</span>
            <div style={{ flex: 1 }} />
            <button className="btn small" onClick={startNew} disabled={busy}>
              ＋ 新建人设
            </button>
          </div>

          <div className="persona-list">
            {personas === null && <div className="conn-note">加载中……</div>}
            {personas?.length === 0 && (
              <div className="conn-note">还没有人设,点右上「＋ 新建人设」建一个。</div>
            )}
            {personas?.map((p) => (
              <div
                key={p.id}
                className={`persona-item${p.is_active ? ' active' : ''}${
                  p.id === editingId ? ' editing' : ''
                }`}
              >
                <button
                  className="persona-item-main"
                  onClick={() => pick(p)}
                  disabled={busy}
                  title={p.is_active ? '当前启用的人设' : '点击启用并查看详情'}
                >
                  <img className="persona-item-avatar" src={avatarOf(p)} alt="" />
                  <span className="persona-item-body">
                    <span className="persona-item-name">
                      {p.name}
                      {p.is_active && <span className="persona-item-badge">当前</span>}
                      {card && bindings.cards[card.id] === p.id && (
                        <span className="persona-item-badge bound" title={`角色卡「${card.name}」绑定了这个人设`}>
                          本卡
                        </span>
                      )}
                      {bindings.default === p.id && (
                        <span className="persona-item-badge bound" title="没绑人设的卡都用它">
                          默认
                        </span>
                      )}
                    </span>
                    <span className="persona-item-desc">{p.description || '(没有人设描述)'}</span>
                  </span>
                </button>
              </div>
            ))}
          </div>

          {formOpen && (
            <div className="persona-form">
              <div className="persona-list-head">
                <span className="conn-label">
                  {creating ? '新建人设 · NEW' : `详情「${editing?.name ?? ''}」`}
                </span>
                <div style={{ flex: 1 }} />
                {creating && (
                  <button className="btn small" onClick={cancelCreate} disabled={busy}>
                    取消
                  </button>
                )}
              </div>

              <div className="persona-identity">
                {!creating && editingId && (
                  <div className="persona-avatar-cell">
                    <span className="conn-label">头像 · 1:1</span>
                    <button
                      className="persona-avatar-btn"
                      onClick={() => onPickAvatar(editingId)}
                      disabled={busy}
                      title="点击更换头像"
                    >
                      <img className="persona-avatar-img" src={avatarOf(editing)} alt="" />
                    </button>
                  </div>
                )}
                <label className="conn-field persona-name-cell">
                  <span className="conn-label">名字 · {'{{user}}'}</span>
                  <input
                    className="text-input"
                    value={name}
                    placeholder="提示词里的玩家名,如:旅行者"
                    disabled={busy}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </div>

              <label className="conn-field">
                <span className="conn-label">人设描述 · DESCRIPTION</span>
                <textarea
                  className="text-input persona-desc"
                  value={description}
                  rows={4}
                  placeholder="外貌、性格、与角色的关系……会填进预设的 personaDescription 占位符"
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              {!creating && editingId && (
                <div className="persona-bind">
                  <span className="conn-label">选卡时自动切换</span>
                  <label className="vp-check">
                    <input
                      type="checkbox"
                      checked={Boolean(card && bindings.cards[card.id] === editingId)}
                      disabled={busy || !card}
                      onChange={(e) => void bindHere(e.target.checked)}
                    />
                    {card ? `绑定到当前角色卡「${card.name}」:选这张卡就切到这个人设` : '绑定到当前角色卡(先选一张卡)'}
                  </label>
                  <label className="vp-check">
                    <input
                      type="checkbox"
                      checked={bindings.default === editingId}
                      disabled={busy}
                      onChange={(e) =>
                        onChangeBindings({ ...bindings, default: e.target.checked ? editingId : null })
                      }
                    />
                    设为默认人设:选没绑人设的卡时切回它
                  </label>
                  {boundNames && <span className="conn-note">绑定的角色卡:{boundNames}</span>}
                </div>
              )}

              <div className="conn-row">
                <button className="btn small accent" onClick={save} disabled={busy}>
                  {creating ? '创建并启用' : '保存'}
                </button>
                {dirty && <span className="conn-note">有未保存的改动</span>}
                <div style={{ flex: 1 }} />
                {!creating && (
                  <button
                    className={`btn small danger${armed ? ' armed' : ''}`}
                    onClick={remove}
                    onBlur={() => setArmed(false)}
                    disabled={busy}
                  >
                    {armed ? '再点一次删除' : '🗑 删除'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
