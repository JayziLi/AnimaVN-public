/**
 * 角色卡编辑器头像下面的「绑定」一栏:这张卡用哪个玩家身份(人设)、哪套预设。
 * 选这张卡时自动换过去;在这里改了当场就换。
 *
 * 和人设抽屉里的「绑定到当前角色卡」、预设面板里的同名勾选改的是同一份数据
 * (lib/personaBinding.ts、lib/presetBinding.ts)。调试台和视觉小说菜单的角色卡页共用。
 */

interface Option {
  id: string;
  name: string;
}

interface Props {
  personas: readonly Option[];
  /** 这张卡绑的人设;null = 没绑 */
  personaId: string | null;
  /** 没绑时用的默认人设名;没设默认人设是 null */
  defaultPersonaName: string | null;
  presets: readonly Option[];
  /** 这张卡绑的预设;null = 没绑 */
  presetId: string | null;
  busy: boolean;
  onPersona: (id: string | null) => void;
  onPreset: (id: string | null) => void;
}

export function CardBindings({
  personas,
  personaId,
  defaultPersonaName,
  presets,
  presetId,
  busy,
  onPersona,
  onPreset,
}: Props) {
  return (
    <div className="card-bind">
      <label className="card-bind-row">
        <span className="card-bind-label">玩家身份</span>
        <select
          className="select"
          value={personaId ?? ''}
          disabled={busy}
          onChange={(e) => onPersona(e.target.value || null)}
        >
          <option value="">
            {defaultPersonaName ? `不绑定(用默认人设「${defaultPersonaName}」)` : '不绑定(不自动切换)'}
          </option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="card-bind-row">
        <span className="card-bind-label">预设</span>
        <select
          className="select"
          value={presetId ?? ''}
          disabled={busy}
          onChange={(e) => onPreset(e.target.value || null)}
        >
          <option value="">不绑定(用对话记的预设)</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
