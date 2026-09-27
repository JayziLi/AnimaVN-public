/**
 * 插件抽屉的「语音」页:插件设置、这张卡用哪些声音、试音台(VoiceBench:试听、调参数)、
 * 语音服务、声音(权重 + 情绪表)、缓存。视觉小说菜单的插件页里也是这一份。
 *
 * 路径都是语音服务那台机器上的(GPT-SoVITS api_v2 只认服务端本地路径)。那边每个角色
 * 目录里有一份 refs.json,整份贴进来就能导入一个角色。环境见 docs/voice-server.md。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  debugApi,
  type CardSprite,
  type TtsApiType,
  type TtsConnection,
  type TtsConnectionPatch,
  type VoiceEmotion,
  type VoiceEmotionPatch,
  type VoiceProfile,
  type VoiceProfilePatch,
} from '../lib/api';
import { BUILTIN_EMOTIONS } from '../plugins/emotions';
import type { VoicePluginState } from '../plugins/useVoicePlugin';
import {
  DEFAULT_VOICE_SAMPLE,
  EMO_MODE_TEXT,
  MAX_WAIT_MAX,
  MAX_WAIT_MIN,
  draftOf,
  draftSummary,
  missingEmotions,
  normalizeVoiceConfig,
  parseRefFileName,
  sampleIn,
  sampleLangOf,
} from '../plugins/voice';
import { bgmPlayer } from '../vn/bgm';
import { voicePlayer } from '../vn/voice';
import { EmotionVectorEditor } from './EmotionVectorEditor';
import { CommitField, DeleteButton } from './pluginFields';
import { errText, formatSize, useRunner, type Notify, type Runner } from './pluginRunner';
import { VoiceBench } from './VoiceBench';

const splitList = (v: string) =>
  v
    .split(/[,，]/)
    .map((a) => a.trim())
    .filter(Boolean);

/** 从已占用的名字里挑一个不撞的:新声音、新声音2… */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let i = 2;
  while (taken.has(name.toLowerCase())) name = `${base}${i++}`;
  return name;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

const ENGINE_NAME: Record<TtsApiType, string> = { gpt_sovits: 'GPT-SoVITS', indextts: 'IndexTTS-2.5' };

type CardRef = { id: string; name: string } | null;

interface Props {
  voice: VoicePluginState;
  card: CardRef;
  sprites: CardSprite[];
  notify: Notify;
}

export function VoicePanel({ voice, card, sprites, notify }: Props) {
  const { refresh } = voice;
  // 别的设备也可能改过,进语音页时刷新一次
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // 试听文本:试音台和情绪表里的 ▶ 共用
  const [sample, setSample] = useState(DEFAULT_VOICE_SAMPLE);

  return (
    <>
      <SettingsGroup voice={voice} />
      <CardGroup voice={voice} card={card} sprites={sprites} />
      <VoiceBench voice={voice} card={card} sample={sample} onSample={setSample} notify={notify} />
      <ConnectionsGroup voice={voice} notify={notify} />
      <ProfilesGroup voice={voice} card={card} notify={notify} sample={sample} />
      <CacheGroup notify={notify} />
    </>
  );
}

function SettingsGroup({ voice }: { voice: VoicePluginState }) {
  const { config, changeConfig } = voice;
  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">设置</span>
        <span className="sp-group-note">
          视觉小说里念角色的台词;旁白和你说的话不念。情绪默认跟着这句的立绘表情走,不用加提示词。全局通用,手机和电脑同步。
        </span>
      </div>
      <label className="vp-check">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => changeConfig({ ...config, enabled: e.target.checked })}
        />
        开启语音
      </label>
      <div className="pl-row">
        <span className="conn-label">文字和语音</span>
        <label className="vp-check">
          <input
            type="radio"
            name="vp-wait"
            checked={!config.waitForVoice}
            onChange={() => changeConfig({ ...config, waitForVoice: false })}
          />
          不等,先出文字(默认)
        </label>
        <label className="vp-check">
          <input
            type="radio"
            name="vp-wait"
            checked={config.waitForVoice}
            onChange={() => changeConfig({ ...config, waitForVoice: true })}
          />
          等语音
        </label>
      </div>
      {config.waitForVoice && (
        <div className="pl-row">
          <span className="conn-label">最多等</span>
          <input
            className="text-input vp-num"
            type="number"
            min={MAX_WAIT_MIN}
            max={MAX_WAIT_MAX}
            step={1}
            value={config.maxWaitSec}
            onChange={(e) =>
              changeConfig(normalizeVoiceConfig({ ...config, maxWaitSec: Number(e.target.value) }))
            }
          />
          <span className="sp-group-note">秒。超时先出文字,语音好了再补上</span>
        </div>
      )}
      <div className="pl-row">
        <span className="conn-label">语音情绪</span>
        <label className="vp-check">
          <input
            type="radio"
            name="vp-emotion"
            checked={!config.fixedEmotion}
            onChange={() => changeConfig({ ...config, fixedEmotion: false })}
          />
          跟着立绘表情变(默认)
        </label>
        <label className="vp-check">
          <input
            type="radio"
            name="vp-emotion"
            checked={config.fixedEmotion}
            onChange={() => changeConfig({ ...config, fixedEmotion: true })}
          />
          不变
        </label>
      </div>
      {config.fixedEmotion && (
        <div className="sp-group-note">
          每句都用声音情绪表里排第一的那行念,立绘照样换表情。想换成别的语气,在下面「声音」里把那一行挪到第一。
        </div>
      )}
    </div>
  );
}

function ConnectionsGroup({ voice, notify }: { voice: VoicePluginState; notify: Notify }) {
  const [busy, run] = useRunner(notify, voice.refresh);
  const [tested, setTested] = useState<Record<string, string>>({});

  const add = (api_type: TtsApiType) =>
    run('添加中', async () => {
      await debugApi.createTtsConnection(
        api_type === 'indextts'
          ? { name: 'IndexTTS', api_type, base_url: 'http://127.0.0.1:9890', emo_alpha: 1 }
          : { name: 'GPT-SoVITS', api_type, base_url: 'http://127.0.0.1:9880', sample_steps: 64 },
      );
    });

  const test = async (c: TtsConnection) => {
    setTested((t) => ({ ...t, [c.id]: '测试中…' }));
    try {
      const r = await debugApi.testTtsConnection(c.id);
      setTested((t) => ({ ...t, [c.id]: `✓ 连得上(${r.ms} ms)` }));
    } catch (e) {
      setTested((t) => ({ ...t, [c.id]: `✗ ${errText(e)}` }));
    }
  };

  const save = (c: TtsConnection, patch: TtsConnectionPatch) =>
    run('保存中', async () => {
      await debugApi.updateTtsConnection(c.id, patch);
    });

  const setSteps = (c: TtsConnection, v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 4 || n > 128) {
      notify('error', '采样步数是 4 到 128 之间的整数');
      return Promise.resolve(false);
    }
    return save(c, { sample_steps: n });
  };

  const setAlpha = (c: TtsConnection, v: string) => {
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) {
      notify('error', '情绪强度在 0 到 1 之间');
      return Promise.resolve(false);
    }
    return save(c, { emo_alpha: n });
  };

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">语音服务</span>
        <span className="sp-group-note">
          跑语音合成的机器:GPT-SoVITS api_v2(默认 9880),或者台式机上的 IndexTTS 小服务(默认 9890)。开发时经 SSH 隧道,地址就是 http://127.0.0.1:端口。
        </span>
      </div>
      <div className="pl-row">
        <button className="btn small" disabled={!!busy} onClick={() => void add('gpt_sovits')}>
          + GPT-SoVITS
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => void add('indextts')}>
          + IndexTTS-2.5
        </button>
        {busy && (
          <span className="sp-group-note">
            <span className="spinner tiny" /> {busy}…
          </span>
        )}
      </div>
      {voice.connections.length === 0 ? (
        <div className="sp-empty">还没有语音服务。</div>
      ) : (
        <div className="pl-sprite-list">
          {voice.connections.map((c) => (
            <div key={c.id} className="pl-sprite vp-card">
              <div className="pl-fields">
                <CommitField label="名字" value={c.name} onCommit={(v) => save(c, { name: v })} />
                <CommitField
                  label="地址"
                  value={c.base_url}
                  placeholder={c.api_type === 'indextts' ? 'http://127.0.0.1:9890' : 'http://127.0.0.1:9880'}
                  onCommit={(v) => save(c, { base_url: v })}
                />
                {c.api_type === 'indextts' ? (
                  <CommitField
                    label="情绪强度"
                    value={String(c.emo_alpha)}
                    placeholder="0.6"
                    onCommit={(v) => setAlpha(c, v)}
                  />
                ) : (
                  <CommitField
                    label="采样步数"
                    value={String(c.sample_steps)}
                    placeholder="64"
                    onCommit={(v) => setSteps(c, v)}
                  />
                )}
                <div className="sp-group-note">
                  {ENGINE_NAME[c.api_type]} · {c.profile_count} 个声音在用 ·{' '}
                  {c.api_type === 'indextts'
                    ? '情绪强度默认 1(用户试听觉得强的好);服务端会先把向量合计压到 0.8 以内。声音在试音台里单独设过的,用声音自己的'
                    : '步数越多越慢,64 步一句约 1.2 秒。声音在试音台里单独设过的,用声音自己的'}
                  {tested[c.id] && ` · ${tested[c.id]}`}
                </div>
              </div>
              <div className="pl-actions">
                <button className="btn small" onClick={() => void test(c)}>
                  测试
                </button>
                <DeleteButton
                  disabled={!!busy || c.profile_count > 0}
                  onConfirm={() => void run('删除中', () => debugApi.deleteTtsConnection(c.id))}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfilesGroup({
  voice,
  card,
  notify,
  sample,
}: {
  voice: VoicePluginState;
  card: CardRef;
  notify: Notify;
  sample: string;
}) {
  const [busy, run] = useRunner(notify, voice.refresh);
  const [open, setOpen] = useState<string | null>(null);
  /** null = 导入框收着 */
  const [importText, setImportText] = useState<string | null>(null);
  const [importConn, setImportConn] = useState('');
  const connId = importConn || voice.connections[0]?.id || '';

  const add = () =>
    run('添加中', async () => {
      if (!connId) throw new Error('先在上面添加一个语音服务');
      const taken = new Set(voice.profiles.map((p) => p.name.toLowerCase()));
      const p = await debugApi.createVoice({ name: uniqueName('新声音', taken), connection_id: connId });
      setOpen(p.id);
    });

  const doImport = () =>
    run('导入中', async () => {
      if (!connId) throw new Error('先在上面添加一个语音服务');
      let refs: unknown;
      try {
        refs = JSON.parse(importText ?? '');
      } catch {
        throw new Error('不是合法的 JSON —— 把 refs.json 的全部内容贴进来');
      }
      const p = await debugApi.importVoice(connId, refs);
      setImportText(null);
      setOpen(p.id);
      notify('ok', `已导入「${p.name}」,${p.emotions.length} 种情绪`);
    });

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">声音</span>
        <span className="sp-group-note">
          一个声音 = 一个语音服务 + 它要的素材(GSV:一套权重 + 每种情绪一段参考;IndexTTS:一段音色参考 + 每种情绪一组向量或一段情绪参考),路径都是语音服务那台机器上的。情绪名和这句的立绘表情名对上就用那一行,对不上用排第一的。
        </span>
      </div>
      <div className="pl-row">
        <button className="btn small" disabled={!!busy} onClick={() => void add()}>
          + 添加声音
        </button>
        <button
          className="btn small"
          disabled={!!busy}
          onClick={() => setImportText(importText === null ? '' : null)}
        >
          导入 refs.json
        </button>
        {busy && (
          <span className="sp-group-note">
            <span className="spinner tiny" /> {busy}…
          </span>
        )}
      </div>
      {importText !== null && (
        <div className="vp-import">
          <textarea
            className="text-input vp-json"
            rows={6}
            spellCheck={false}
            placeholder="把语音服务那台机器上 refs\<角色>\refs.json 的全部内容贴进来"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="pl-row">
            {voice.connections.length > 1 && (
              <select className="text-input" value={connId} onChange={(e) => setImportConn(e.target.value)}>
                {voice.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn small accent"
              disabled={!!busy || !importText.trim()}
              onClick={() => void doImport()}
            >
              导入
            </button>
            <span className="sp-group-note">同名的声音会更新权重路径和同名情绪,不会重复添加</span>
          </div>
        </div>
      )}
      {voice.profiles.length === 0 ? (
        <div className="sp-empty">还没有声音。有 refs.json 的话直接导入最省事。</div>
      ) : (
        <div className="pl-sprite-list">
          {voice.profiles.map((p) => (
            <ProfileCard
              key={p.id}
              p={p}
              open={open === p.id}
              onToggle={() => setOpen(open === p.id ? null : p.id)}
              connections={voice.connections}
              card={card}
              busy={busy}
              run={run}
              sample={sample}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileCard({
  p,
  open,
  onToggle,
  connections,
  card,
  busy,
  run,
  sample,
}: {
  p: VoiceProfile;
  open: boolean;
  onToggle: () => void;
  connections: TtsConnection[];
  card: CardRef;
  busy: string | null;
  run: Runner;
  sample: string;
}) {
  const conn = connections.find((c) => c.id === p.connection_id);
  const isIndex = conn?.api_type === 'indextts';
  const [warm, setWarm] = useState('');
  const save = (patch: VoiceProfilePatch) =>
    run('保存中', async () => {
      await debugApi.updateVoice(p.id, patch);
    });

  const warmup = async () => {
    setWarm('预热中…(服务刚启动时要 40 秒左右)');
    try {
      const r = await debugApi.warmupVoice(p.id, true);
      setWarm(`✓ 预热完成,${secs(r.ms)}`);
    } catch (e) {
      setWarm(`✗ ${errText(e)}`);
    }
  };

  return (
    <div className="pl-sprite vp-profile">
      <button className="vp-head" onClick={onToggle} aria-expanded={open}>
        <b>{p.name}</b>
        <span className="sp-group-note">
          {p.emotions.length} 种情绪 · {conn?.name ?? '没选语音服务'}
          {p.card_count > 0 && ` · ${p.card_count} 张卡在用`}
        </span>
        <span className="vp-caret">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="vp-body">
          <div className="pl-fields">
            <CommitField label="名字" value={p.name} onCommit={(v) => save({ name: v })} />
            <CommitField
              label="别名"
              placeholder="用逗号分隔。台词前写的「名字：」对上名字或别名就用这个声音"
              value={p.aliases.join(', ')}
              onCommit={(v) => save({ aliases: splitList(v) })}
            />
            <label className="pl-field">
              <span className="conn-label">语音服务</span>
              <select
                className="text-input"
                value={p.connection_id}
                onChange={(e) => void save({ connection_id: e.target.value })}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {isIndex ? (
              <CommitField
                label="音色参考"
                placeholder="D:/AnimaVoice/refs/角色/【平静】原文.wav(5–10 秒、干净的一段)"
                value={p.ref_path}
                onCommit={(v) => save({ ref_path: v })}
              />
            ) : (
              <>
                <CommitField
                  label="GPT 权重(.ckpt)"
                  placeholder="D:/AnimaVoice/models/角色/角色-e10.ckpt"
                  value={p.gpt_weights}
                  onCommit={(v) => save({ gpt_weights: v })}
                />
                <CommitField
                  label="SoVITS 权重(.pth)"
                  placeholder="D:/AnimaVoice/models/角色/角色_e10_s230_l32.pth"
                  value={p.sovits_weights}
                  onCommit={(v) => save({ sovits_weights: v })}
                />
              </>
            )}
            <div className="sp-group-note">
              参数:{draftSummary(draftOf(p), conn?.api_type ?? 'gpt_sovits') || '全部默认'}
              (语速、语言和合成参数在上面的试音台里调)
            </div>
          </div>
          <EmotionTable p={p} isIndex={isIndex} card={card} busy={busy} run={run} sample={sample} />
          <div className="pl-row">
            <button className="btn small" onClick={() => void warmup()}>
              预热
            </button>
            <span className="sp-group-note">
              {warm ||
                (isIndex
                  ? '合成一句,让服务把模型和这段音色参考准备好。服务刚启动时用'
                  : '强制重新加载这个声音的权重,再合成一句。服务刚重启、或者手动切过那边的权重之后用')}
            </span>
            <div style={{ flex: 1 }} />
            <DeleteButton
              disabled={!!busy}
              label="删除声音"
              onConfirm={() => void run('删除中', () => debugApi.deleteVoice(p.id))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function EmotionTable({
  p,
  isIndex,
  card,
  busy,
  run,
  sample,
}: {
  p: VoiceProfile;
  isIndex: boolean;
  card: CardRef;
  busy: string | null;
  run: Runner;
  sample: string;
}) {
  const [adding, setAdding] = useState('');
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [filled, setFilled] = useState('');

  const save = (e: VoiceEmotion, patch: VoiceEmotionPatch) =>
    run('保存中', async () => {
      await debugApi.updateVoiceEmotion(p.id, e.id, patch);
    });

  const add = () =>
    run('添加中', async () => {
      if (isIndex) {
        // 名字要和立绘表情名一致,撞名就让后端报出来,不偷偷改名
        await debugApi.createVoiceEmotion(p.id, { label: adding.trim() });
      } else {
        const path = adding.trim().replace(/^"|"$/g, '');
        const parsed = parseRefFileName(path);
        const taken = new Set(
          p.emotions.flatMap((e) => [e.label, ...e.aliases]).map((n) => n.toLowerCase()),
        );
        await debugApi.createVoiceEmotion(p.id, {
          label: uniqueName(parsed?.label || '情绪', taken),
          ref_path: path,
          prompt_text: parsed?.text ?? '',
        });
      }
      setAdding('');
    });

  const fill = () =>
    run('补齐中', async () => {
      if (!card) return;
      const rows = await debugApi.fillVoiceEmotionsFromSprites(p.id, card.id);
      const added = rows.length - p.emotions.length;
      setFilled(added > 0 ? `补了 ${added} 行,向量按常见表情名预填了,听一下再调` : '立绘表情都已经有对应的行了');
    });

  const moveUp = (i: number) =>
    run('排序中', async () => {
      const ids = p.emotions.map((e) => e.id);
      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      await debugApi.reorderVoiceEmotions(p.id, ids);
    });

  const listen = async (e: VoiceEmotion) => {
    // 在点击里解锁:合成要几秒,等回来就不算用户手势了
    bgmPlayer.unlock();
    setPreview((s) => ({ ...s, [e.id]: '合成中…' }));
    try {
      const r = await debugApi.speak({
        profile_id: p.id,
        emotion: e.label,
        // 框里是内置例句的话,换成这个声音念的语言那一版
        text: sampleIn(sample.trim() || DEFAULT_VOICE_SAMPLE, sampleLangOf(p.text_lang)),
      });
      await voicePlayer.playBuffer(r.audio);
      setPreview((s) => ({
        ...s,
        [e.id]: `${r.cache === 'hit' ? '缓存命中' : '新合成'}${isIndex ? ` · ${EMO_MODE_TEXT[r.mode]}` : ''} · ${secs(r.ms)}`,
      }));
    } catch (err) {
      setPreview((s) => ({ ...s, [e.id]: `✗ ${errText(err)}` }));
    }
  };

  const setRef = (e: VoiceEmotion, v: string) => {
    const patch: VoiceEmotionPatch = { ref_path: v };
    // 原文还空着、文件名是「【情绪】原文.wav」时顺手填上
    const parsed = parseRefFileName(v);
    if (parsed && !e.prompt_text) patch.prompt_text = parsed.text;
    return save(e, patch);
  };

  return (
    <div className="vp-emotions">
      <div className="sp-group-note">
        {isIndex
          ? '情绪,排第一的是默认。有情绪参考就照参考的语气念,没有就用向量,都没有就沿用音色参考的语气。向量顺序:喜 怒 哀 惧 厌 郁 惊 平,每项 0–1.2,合计不超过 1.5。服务端和官方网页一样会先归一化:合计压到 0.8 以内,惊讶 ×0.69、平静 ×0.56,再乘情绪强度 —— 所以听着偏弱时先调情绪强度。'
          : '情绪,排第一的是默认。参考音频必须 3–10 秒,5–10 秒最好;3 秒左右的短参考会有电子音。'}
      </div>
      {isIndex && card && (
        <div className="pl-row">
          <button className="btn small" disabled={!!busy} onClick={() => void fill()}>
            按「{card.name}」的立绘表情补齐
          </button>
          <span className="sp-group-note">{filled || '每个立绘表情一行(没配立绘的卡按内置基础表情),向量按常见表情名预填,已有的行不动'}</span>
        </div>
      )}
      {p.emotions.map((e, i) => (
        <div key={e.id} className="pl-sprite vp-emotion">
          <button
            className="pl-thumb pl-play"
            title="用这段参考念一遍试音台里的句子"
            onClick={() => void listen(e)}
          >
            <span>▶</span>
          </button>
          <div className="pl-fields">
            <div className="pl-field-row">
              <CommitField label="情绪名" value={e.label} onCommit={(v) => save(e, { label: v })} />
              {i === 0 && <span className="pl-badge">默认</span>}
            </div>
            <CommitField
              label="别名"
              placeholder="用逗号分隔。和立绘表情名对上就用这段"
              value={e.aliases.join(', ')}
              onCommit={(v) => save(e, { aliases: splitList(v) })}
            />
            {isIndex ? (
              <>
                <CommitField
                  label="情绪参考"
                  placeholder="可选。填了就照这段的语气念,向量不生效;可以是别的角色的声音"
                  value={e.ref_path}
                  onCommit={(v) => save(e, { ref_path: v })}
                />
                <EmotionVectorEditor
                  value={e.emo_vector}
                  disabled={!!e.ref_path}
                  onCommit={(v) => save(e, { emo_vector: v })}
                />
              </>
            ) : (
              <>
                <CommitField
                  label="参考音频"
                  placeholder="D:/AnimaVoice/refs/角色/【平静】原文.wav"
                  value={e.ref_path}
                  onCommit={(v) => setRef(e, v)}
                />
                <CommitField
                  label="原文"
                  placeholder="参考音频里说的话,一字不差"
                  value={e.prompt_text}
                  onCommit={(v) => save(e, { prompt_text: v })}
                />
              </>
            )}
            {preview[e.id] && <div className="sp-group-note">{preview[e.id]}</div>}
          </div>
          <div className="pl-actions">
            <button
              className="btn small"
              disabled={!!busy || i === 0}
              onClick={() => void moveUp(i)}
              title="上移(移到第一 = 设为默认)"
            >
              ↑
            </button>
            <DeleteButton
              disabled={!!busy}
              onConfirm={() => void run('删除中', () => debugApi.deleteVoiceEmotion(p.id, e.id))}
            />
          </div>
        </div>
      ))}
      <div className="pl-row">
        <input
          className="text-input pl-wide"
          value={adding}
          placeholder={
            isIndex
              ? '情绪名,和立绘表情名一致,比如 开心'
              : '贴参考音频的路径;文件名是「【情绪】原文.wav」就自动填情绪名和原文'
          }
          onChange={(e) => setAdding(e.target.value)}
        />
        <button className="btn small" disabled={!!busy || !adding.trim()} onClick={() => void add()}>
          + 添加情绪
        </button>
      </div>
    </div>
  );
}

function CardGroup({
  voice,
  card,
  sprites,
}: {
  voice: VoicePluginState;
  card: { id: string; name: string } | null;
  sprites: CardSprite[];
}) {
  const { binding, profiles, bind, cast, connections, config } = voice;
  if (!card) {
    return (
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">这张卡的声音</span>
        </div>
        <div className="sp-empty">先选一张角色卡。</div>
      </div>
    );
  }
  const others = profiles.filter((p) => p.id !== binding.main);
  // 没立绘的卡,AI 写的表情会匹配到内置基础表情上,拿它们对照
  const missing = missingEmotions(
    sprites.length > 0 ? sprites.map((s) => s.label) : BUILTIN_EMOTIONS.map((e) => e.label),
    cast.main,
  );
  const main = cast.main;
  const mainIsIndex = connections.find((c) => c.id === main?.connection_id)?.api_type === 'indextts';

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">「{card.name}」的声音</span>
        <span className="sp-group-note">
          主声音念「{card.name}」自己的台词。卡里还有别的角色时,把他们的声音也勾上:台词前写了「名字：」、名字或别名对得上就用那个声音。
        </span>
      </div>
      <label className="pl-field">
        <span className="conn-label">主声音</span>
        <select
          className="text-input"
          value={binding.main ?? ''}
          onChange={(e) =>
            void bind({
              main: e.target.value || null,
              extras: binding.extras.filter((x) => x !== e.target.value),
            })
          }
        >
          <option value="">不念</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {others.length > 0 && (
        <div className="pl-row">
          <span className="conn-label">其他角色</span>
          {others.map((p) => (
            <label key={p.id} className="vp-check">
              <input
                type="checkbox"
                checked={binding.extras.includes(p.id)}
                onChange={(e) =>
                  void bind({
                    main: binding.main,
                    extras: e.target.checked
                      ? [...binding.extras, p.id]
                      : binding.extras.filter((x) => x !== p.id),
                  })
                }
              />
              {p.name}
            </label>
          ))}
        </div>
      )}
      {main && mainIsIndex && !main.ref_path && (
        <span className="pl-error">「{main.name}」还没填音色参考,念不了</span>
      )}
      {main && !mainIsIndex && main.emotions.length === 0 && (
        <span className="pl-error">「{main.name}」还没有情绪(参考音频),念不了</span>
      )}
      {main && mainIsIndex && main.ref_path && main.emotions.length === 0 && (
        <div className="sp-group-note">
          「{main.name}」还没有情绪行,每句都沿用音色参考的语气。可以在上面展开这个声音,点「按立绘表情补齐」。
        </div>
      )}
      {main && main.emotions.length > 0 && config.fixedEmotion && (
        <div className="sp-group-note">语音情绪设成了不变:「{main.name}」每句都用「{main.emotions[0].label}」念。</div>
      )}
      {main && main.emotions.length > 0 && !config.fixedEmotion && missing.length > 0 && (
        <div className="sp-group-note">
          {sprites.length > 0 ? '这些立绘表情' : '这张卡没配立绘,用的是内置基础表情。这些'}在「{main.name}」的情绪表里没有,会用情绪识别模型挑最接近的一行念(模型没装时用默认「{main.emotions[0].label}」)。想指定的话,给那一行加别名:
          {missing.join('、')}
        </div>
      )}
    </div>
  );
}

function CacheGroup({ notify }: { notify: Notify }) {
  const [stats, setStats] = useState<{ count: number; bytes: number; limit_bytes: number } | null>(null);
  const load = useCallback(async () => {
    try {
      setStats(await debugApi.ttsCacheStats());
    } catch (e) {
      notify('error', `缓存统计读取失败: ${errText(e)}`);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = async () => {
    try {
      await debugApi.clearTtsCache();
    } catch (e) {
      notify('error', errText(e));
    }
    await load();
  };

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">缓存</span>
        <span className="sp-group-note">
          合成过的台词存在后端,回看、重播直接用,不重新合成。换了权重、参考、原文、步数、向量或情绪强度,旧的就不会再被用到。
        </span>
      </div>
      <div className="pl-row">
        <span className="sp-group-note">
          {stats
            ? `${stats.count} 句 · ${stats.bytes ? formatSize(stats.bytes) : '0 KB'} / 上限 ${formatSize(stats.limit_bytes)}`
            : '…'}
        </span>
        <DeleteButton disabled={!stats?.count} label="清空缓存" onConfirm={() => void clear()} />
      </div>
    </div>
  );
}
