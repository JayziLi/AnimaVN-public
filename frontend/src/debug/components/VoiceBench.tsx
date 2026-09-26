/**
 * 插件页「语音」里的试音台:挑一个声音和情绪,念任意一句。语速、语言和合成参数先在这里试,
 * 满意了再存到声音上(游戏里就按这组念)。每次念的结果按顺序留着,可以对比、重播、下载。
 *
 * 试的参数随请求一起发(tuning),不存。存到声音上之后,视觉小说里这个声音已经合成好的
 * 句子会作废重念(useVoicePlugin 比较前后的设置)。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { debugApi, type EmoMode, type TtsApiType, type VoiceParams } from '../lib/api';
import type { VoicePluginState } from '../plugins/useVoicePlugin';
import {
  EMO_MODE_TEXT,
  GSV_NUM_PARAMS,
  INDEX_NUM_PARAMS,
  SPEED_RANGE,
  TEXT_SPLIT_METHODS,
  VOICE_LANGS,
  draftOf,
  draftSummary,
  sameDraft,
  type VoiceDraft,
} from '../plugins/voice';
import { bgmPlayer } from '../vn/bgm';
import { useVoice, voicePlayer } from '../vn/voice';
import { errText, type Notify } from './pluginRunner';

/** 最多留几条试听结果(一条十秒的 wav 约 1 MB) */
const MAX_TAKES = 20;
const SEED_MAX = 2 ** 32 - 1;

/** 常用试听句:按要念的语言给,点一下填进去 */
const SAMPLES: Record<'zh' | 'ja', { name: string; text: string }[]> = {
  zh: [
    { name: '日常', text: '你好，今天过得怎么样？我一直在等你。' },
    { name: '开心', text: '太好了！我就知道你一定可以做到的！' },
    { name: '难过', text: '……没关系的，我一个人也可以。你不用担心我。' },
    { name: '惊讶', text: '诶？！真的吗？你什么时候回来的？' },
    { name: '生气', text: '你到底有没有在听我说话啊！' },
    {
      name: '长句',
      text: '其实我一直想告诉你，那天在车站分开之后，我每天都会想起你说过的话。虽然不知道你还记不记得，但对我来说，那是很重要的约定。',
    },
  ],
  ja: [
    { name: '日常', text: 'おかえりなさい。今日はどうだった？ずっと待ってたんだよ。' },
    { name: '开心', text: 'やった！絶対できるって信じてたよ！' },
    { name: '难过', text: '……大丈夫。一人でも平気だから、心配しないで。' },
    { name: '惊讶', text: 'えっ？！本当に？いつ帰ってきたの？' },
    { name: '生气', text: 'ちょっと、ちゃんと話聞いてるの？' },
    {
      name: '长句',
      text: '実はずっと言いたかったんだ。あの日駅で別れてから、あなたの言葉を毎日思い出してた。覚えてるかわからないけど、私にとっては大切な約束なんだ。',
    },
  ],
};

interface Take {
  id: number;
  voice: string;
  /** 后端实际用的情绪名(对不上时是默认那行) */
  emotion: string;
  mode: EmoMode;
  engine: TtsApiType;
  text: string;
  /** 这次用的参数,一句话 */
  summary: string;
  seed: number | null;
  ms: number;
  cache: 'hit' | 'miss';
  audio: ArrayBuffer;
}

interface Props {
  voice: VoicePluginState;
  card: { id: string; name: string } | null;
  /** 试听文本:和下面情绪表里的 ▶ 共用 */
  sample: string;
  onSample: (text: string) => void;
  notify: Notify;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function VoiceBench({ voice, card, sample, onSample, notify }: Props) {
  const { profiles, connections, binding } = voice;
  // 默认试这张卡的主声音
  const [picked, setPicked] = useState<string | null>(null);
  const profile =
    profiles.find((p) => p.id === picked) ??
    profiles.find((p) => p.id === binding.main) ??
    profiles[0] ??
    null;
  const conn = connections.find((c) => c.id === profile?.connection_id) ?? null;
  const engine: TtsApiType = conn?.api_type ?? 'gpt_sovits';

  const [emotion, setEmotion] = useState('');
  const emotionLabel = profile?.emotions.some((e) => e.label === emotion) ? emotion : '';

  // 每个声音一份草稿;没动过的声音跟着存着的走
  const [drafts, setDrafts] = useState<Record<string, VoiceDraft>>({});
  const saved = profile ? draftOf(profile) : null;
  const draft = profile ? (drafts[profile.id] ?? saved) : null;
  const dirty = Boolean(draft && saved && !sameDraft(draft, saved));
  const dropDraft = (id: string) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });

  const [seedText, setSeedText] = useState('');
  const seed = seedText.trim() === '' ? null : Number(seedText);
  const seedBad = seed !== null && !(Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX);

  const [showParams, setShowParams] = useState(false);
  const [takes, setTakes] = useState<Take[]>([]);
  const nextId = useRef(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ---- 播放:单条直接放;「每种情绪各念一遍」排成一队,一条念完放下一条 ----

  const snap = useVoice();
  const [playing, setPlaying] = useState<number | null>(null);
  const [autoQueue, setAutoQueue] = useState<number[]>([]);
  const starting = useRef(false);
  const playingId = snap.speaking === 'preview' ? playing : null;

  const play = async (t: Take) => {
    starting.current = true;
    try {
      await voicePlayer.playBuffer(t.audio);
      setPlaying(t.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      starting.current = false;
    }
  };

  useEffect(() => {
    if (snap.speaking !== null || starting.current || autoQueue.length === 0) return;
    const [id, ...rest] = autoQueue;
    setAutoQueue(rest);
    const t = takes.find((x) => x.id === id);
    if (t) void play(t);
  }, [snap.speaking, autoQueue, takes]);

  const stop = () => {
    setAutoQueue([]);
    voicePlayer.stop();
  };

  // ---- 合成 ----

  const text = sample.trim();
  const canRun = Boolean(profile && draft && text) && !busy && !seedBad;

  const synth = async (emo: string, fresh: boolean): Promise<Take> => {
    if (!profile || !draft) throw new Error('先选一个声音');
    const r = await debugApi.speak({ profile_id: profile.id, emotion: emo || null, text }, fresh, {
      ...draft,
      seed,
    });
    const take: Take = {
      id: nextId.current++,
      voice: profile.name,
      emotion: r.emotion,
      mode: r.mode,
      engine,
      text,
      summary: draftSummary(draft, engine),
      seed: engine === 'gpt_sovits' ? seed : null,
      ms: r.ms,
      cache: r.cache,
      audio: r.audio,
    };
    setTakes((ts) => [take, ...ts].slice(0, MAX_TAKES));
    return take;
  };

  const generate = async (fresh: boolean) => {
    if (!canRun) return;
    // 在点击里解锁:合成要一两秒,回来就不算用户手势了
    bgmPlayer.unlock();
    setAutoQueue([]);
    setError(null);
    setBusy(fresh ? '换一种念法' : '合成中');
    try {
      await play(await synth(emotionLabel, fresh));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const everyEmotion = async () => {
    if (!canRun || !profile) return;
    bgmPlayer.unlock();
    stop();
    setError(null);
    const rows = profile.emotions;
    try {
      for (let i = 0; i < rows.length; i++) {
        setBusy(`${rows[i].label}(${i + 1}/${rows.length})`);
        const t = await synth(rows[i].label, false);
        setAutoQueue((q) => [...q, t.id]);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const download = (t: Take) => {
    const url = URL.createObjectURL(new Blob([t.audio], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.voice}-${t.emotion || '默认'}-${t.id}.wav`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  // ---- 存 / 换声线 ----

  const save = async () => {
    if (!profile || !draft) return;
    setSaving(true);
    try {
      await debugApi.updateVoice(profile.id, {
        speed: draft.speed,
        text_lang: draft.text_lang,
        params: draft.params,
      });
      await voice.refresh();
      dropDraft(profile.id);
      notify('ok', `「${profile.name}」的参数已保存,游戏里接下来按这组念`);
    } catch (e) {
      notify('error', `保存失败: ${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const makeMain = () => {
    if (!profile) return;
    void voice.bind({ main: profile.id, extras: binding.extras.filter((x) => x !== profile.id) });
  };

  if (profiles.length === 0 || !profile || !draft) {
    return (
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">试音台</span>
        </div>
        <div className="sp-empty">还没有声音。先在下面「声音」里添加或导入一个。</div>
      </div>
    );
  }

  const isMain = binding.main === profile.id;
  const samples = SAMPLES[draft.text_lang === 'ja' ? 'ja' : 'zh'];
  const missingRef = engine === 'indextts' ? !profile.ref_path : profile.emotions.length === 0;
  const summary = draftSummary(draft, engine);

  return (
    <div className="sp-group vb">
      <div className="sp-group-head">
        <span className="sp-group-title">试音台</span>
        <span className="sp-group-note">
          念任意一句听效果;换声音、换情绪、调参数都在这里试。试的参数不影响游戏,点「保存」才生效。
        </span>
      </div>

      <div className="vb-row">
        <label className="pl-field vb-voice">
          <span className="conn-label">声音</span>
          <select
            className="text-input"
            value={profile.id}
            onChange={(e) => setPicked(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === binding.main ? '(主声音)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="pl-field vb-emotion">
          <span className="conn-label">情绪</span>
          <select className="text-input" value={emotionLabel} onChange={(e) => setEmotion(e.target.value)}>
            <option value="">默认{profile.emotions[0] ? `(${profile.emotions[0].label})` : ''}</option>
            {profile.emotions.slice(1).map((e) => (
              <option key={e.id} value={e.label}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        {card &&
          (isMain ? (
            <span className="pl-badge vb-main">「{card.name}」的主声音</span>
          ) : (
            <button className="btn small accent" onClick={makeMain} title="换声线:这张卡的台词改用这个声音念">
              设为「{card.name}」的主声音
            </button>
          ))}
      </div>
      {missingRef && (
        <span className="pl-error">
          {engine === 'indextts'
            ? `「${profile.name}」还没填音色参考,念不了(下面「声音」里展开填)`
            : `「${profile.name}」还没有参考音频,念不了(下面「声音」里展开加情绪)`}
        </span>
      )}

      <textarea
        className="text-input vb-text"
        rows={2}
        maxLength={500}
        value={sample}
        placeholder="要念的句子"
        onChange={(e) => onSample(e.target.value)}
      />
      <div className="vb-chips">
        {samples.map((s) => (
          <button key={s.name} className="vb-chip" onClick={() => onSample(s.text)}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="vb-params-head">
        <button className="vp-head vb-toggle" onClick={() => setShowParams(!showParams)} aria-expanded={showParams}>
          <b>参数</b>
          <span className="sp-group-note">{summary || '全部默认'}</span>
          {dirty && <span className="pl-badge vb-dirty">没保存</span>}
          <span className="vp-caret">{showParams ? '收起' : '展开'}</span>
        </button>
      </div>
      {showParams && (
        <div className="vb-params">
          <ParamsEditor
            draft={draft}
            engine={engine}
            connSteps={conn?.sample_steps ?? 64}
            connAlpha={conn?.emo_alpha ?? 1}
            onChange={(next) => setDrafts((d) => ({ ...d, [profile.id]: next }))}
          />
          {engine === 'gpt_sovits' && (
            <ParamRow
              name="固定种子"
              note="对比参数时填同一个数,两次的差别就只来自参数;空着 = 每次随机。只在试音台里用,不保存"
              isDefault={seed === null}
            >
              <input
                className="text-input vb-seed"
                inputMode="numeric"
                value={seedText}
                placeholder="随机"
                onChange={(e) => setSeedText(e.target.value)}
              />
              {seedBad && <span className="pl-error">0 到 {SEED_MAX} 的整数</span>}
            </ParamRow>
          )}
          <div className="pl-row">
            <button className="btn small accent" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? '保存中…' : `保存到「${profile.name}」`}
            </button>
            <button className="btn small" disabled={!dirty || saving} onClick={() => dropDraft(profile.id)}>
              撤销改动
            </button>
            <span className="sp-group-note">保存后游戏里按这组念,之前合成好的句子会重新合成</span>
          </div>
        </div>
      )}

      <div className="pl-row vb-actions">
        <button className="btn small accent" disabled={!canRun} onClick={() => void generate(false)}>
          ▶ 念这句
        </button>
        <button
          className="btn small"
          disabled={!canRun}
          onClick={() => void generate(true)}
          title="不用缓存,再合成一遍(每次的随机种子不同,念法会变;固定了种子就差不多是同一种)"
        >
          换一种念法
        </button>
        <button
          className="btn small"
          disabled={!canRun || profile.emotions.length < 2}
          onClick={() => void everyEmotion()}
          title="这句用每种情绪各念一遍,依次播放"
        >
          每种情绪各念一遍
        </button>
        {busy && (
          <span className="sp-group-note">
            <span className="spinner tiny" /> {busy}…
          </span>
        )}
        {(playingId !== null || autoQueue.length > 0) && (
          <button className="btn small" onClick={stop}>
            ■ 停
          </button>
        )}
      </div>
      {error && <span className="pl-error">{error}</span>}

      {takes.length > 0 && (
        <div className="vb-takes">
          <div className="pl-row">
            <span className="sp-group-note">念过的(新的在上面,最多留 {MAX_TAKES} 条)</span>
            <div style={{ flex: 1 }} />
            <button className="btn small" onClick={() => setTakes([])}>
              清空
            </button>
          </div>
          {takes.map((t) => (
            <div key={t.id} className={`vb-take${playingId === t.id ? ' playing' : ''}`}>
              <button
                className="vb-take-play"
                onClick={() => {
                  setAutoQueue([]);
                  if (playingId === t.id) voicePlayer.stop();
                  else {
                    bgmPlayer.unlock();
                    void play(t);
                  }
                }}
                aria-label={playingId === t.id ? '停' : '播放'}
              >
                {playingId === t.id ? '■' : '▶'}
              </button>
              <div className="vb-take-body">
                <div className="vb-take-head">
                  <b>#{t.id}</b> {t.voice} · {t.emotion || '默认'}
                  {t.engine === 'indextts' && `(${EMO_MODE_TEXT[t.mode]})`}
                  <span className="sp-group-note">
                    {' '}
                    · {t.cache === 'hit' ? '缓存' : '新合成'} · {secs(t.ms)}
                  </span>
                </div>
                <div className="sp-group-note">
                  {t.summary || '默认参数'}
                  {t.seed !== null && ` · 种子 ${t.seed}`}
                </div>
                <div className="vb-take-text">{t.text}</div>
              </div>
              <button className="btn small" onClick={() => download(t)} title="存成 wav">
                下载
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ParamRow({
  name,
  note,
  isDefault,
  children,
}: {
  name: string;
  note: string;
  isDefault: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`vb-param${isDefault ? ' is-default' : ''}`}>
      <span className="vb-param-name">{name}</span>
      <div className="vb-param-ctl">{children}</div>
      <span className="vb-param-note">{note}</span>
    </div>
  );
}

function NumRow({
  name,
  note,
  value,
  def,
  defLabel,
  min,
  max,
  step,
  unit = '',
  onChange,
}: {
  name: string;
  note: string;
  /** undefined = 用默认 */
  value: number | undefined;
  def: number;
  defLabel: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number | undefined) => void;
}) {
  const shown = value ?? def;
  return (
    <ParamRow name={name} note={note} isDefault={value === undefined}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={name}
        onChange={(e) => onChange(round2(Number(e.target.value)))}
      />
      <span className="vb-param-value">
        {round2(shown)}
        {unit}
      </span>
      {value === undefined ? (
        <span className="vb-param-def">{defLabel}</span>
      ) : (
        <button className="btn small" onClick={() => onChange(undefined)}>
          默认
        </button>
      )}
    </ParamRow>
  );
}

function ParamsEditor({
  draft,
  engine,
  connSteps,
  connAlpha,
  onChange,
}: {
  draft: VoiceDraft;
  engine: TtsApiType;
  /** 声音上没设时跟的语音服务的值 */
  connSteps: number;
  connAlpha: number;
  onChange: (next: VoiceDraft) => void;
}) {
  const setParam = <K extends keyof VoiceParams>(k: K, v: VoiceParams[K] | undefined) => {
    const params = { ...draft.params };
    if (v === undefined) delete params[k];
    else params[k] = v;
    onChange({ ...draft, params });
  };
  const langs = VOICE_LANGS[engine];
  const numParams = engine === 'indextts' ? INDEX_NUM_PARAMS : GSV_NUM_PARAMS;

  return (
    <>
      <ParamRow
        name="语言"
        note="要念的文字是什么语言;参考音频的语言按它的原文自动判断"
        isDefault={draft.text_lang === 'zh'}
      >
        <select
          className="text-input"
          value={draft.text_lang}
          onChange={(e) => onChange({ ...draft, text_lang: e.target.value })}
        >
          {langs.map((l) => (
            <option key={l.value} value={l.value}>
              {l.name}
            </option>
          ))}
          {!langs.some((l) => l.value === draft.text_lang) && (
            <option value={draft.text_lang}>{draft.text_lang}</option>
          )}
        </select>
      </ParamRow>
      <NumRow
        name="语速"
        note="大于 1 念得快"
        value={draft.speed === 1 ? undefined : draft.speed}
        def={1}
        defLabel="默认"
        {...SPEED_RANGE}
        onChange={(v) => onChange({ ...draft, speed: v ?? 1 })}
      />
      {numParams.map((p) => (
        <NumRow
          key={p.key}
          name={p.name}
          note={p.note}
          value={draft.params[p.key]}
          def={p.def ?? (p.key === 'sample_steps' ? connSteps : connAlpha)}
          defLabel={p.def === null ? '跟语音服务' : '默认'}
          min={p.min}
          max={p.max}
          step={p.step}
          unit={p.unit}
          onChange={(v) => setParam(p.key, v)}
        />
      ))}
      {engine === 'gpt_sovits' && (
        <>
          <ParamRow
            name="断句"
            note="一句先按这个规则切成几段再合成;长句念着乱时换一种试试"
            isDefault={!draft.params.text_split_method}
          >
            <select
              className="text-input"
              value={draft.params.text_split_method ?? 'cut5'}
              onChange={(e) => {
                const v = e.target.value as NonNullable<VoiceParams['text_split_method']>;
                setParam('text_split_method', v === 'cut5' ? undefined : v);
              }}
            >
              {TEXT_SPLIT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.name}
                  {m.value === 'cut5' ? '(默认)' : ''}
                </option>
              ))}
            </select>
          </ParamRow>
          <ParamRow
            name="并行推理"
            note="关掉电子音略少一点,但断句和语气会变;实测快慢差不多"
            isDefault={draft.params.parallel_infer === undefined}
          >
            <label className="vp-check">
              <input
                type="checkbox"
                checked={draft.params.parallel_infer ?? true}
                onChange={(e) => setParam('parallel_infer', e.target.checked ? undefined : false)}
              />
              开(默认)
            </label>
          </ParamRow>
        </>
      )}
    </>
  );
}
