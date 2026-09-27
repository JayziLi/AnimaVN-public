/**
 * 「历史」里一句的语音详情 —— 排查语音用。从头到尾把这句怎么念摆出来:
 *   说话人 → 声音;立绘标签 → 认成哪个表情(精确 / 模型);要的情绪 → 声音情绪表里
 *   挑中哪一行(名字 / 别名 / 模型就近 / 默认)→ 参考音频和原文;发给语音服务的原样请求;
 *   缓存里有没有、这次放的时候怎么样。不念的句子写原因。参考音频那几行能点 ▶ 听原声。
 *
 * 念的句子问后端 /api/tts/explain:和真正合成走同一套挑法,但不合成、不碰语音服务。
 */

import { useEffect, useState } from 'react';
import { debugApi, type SpeakRequest, type VoiceExplain, type VoiceProfile } from '../lib/api';
import type { EmotionContext, TagMatch } from '../plugins/emotionMatch';
import {
  VOICE_LANGS,
  spriteHitsUpTo,
  spriteLabelAfter,
  voiceKey,
  voiceSkipReason,
} from '../plugins/voice';
import { bgmPlayer } from './bgm';
import type { TagHit, VNLine } from './script';
import { useVoice, voicePlayer, type ClipState } from './voice';

interface Props {
  line: VNLine;
  /** 这句是这条回复的第几句(从 0 数) */
  index: number;
  /** 这条回复的全部标签 */
  hits: readonly TagHit[];
  /** 这条回复第一句之前生效的表情(之前各条回复累计下来的) */
  emotionBefore: string | null;
  /** 这句怎么念;不念是 null */
  plan: SpeakRequest | null;
  /** 说话人对上的声音(玩家台词是 null) */
  profile: VoiceProfile | null;
  ctx: EmotionContext;
  voiceEnabled: boolean;
  /** 插件设置里选了情绪不变 */
  fixedEmotion: boolean;
  /** 流式时这条回复的最后一句(还在写) */
  streamingLast: boolean;
  /** 从这句接着看 */
  onJump: () => void;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

const langName = (lang: string) =>
  [...VOICE_LANGS.gpt_sovits, ...VOICE_LANGS.indextts].find((l) => l.value === lang)?.name ?? lang;

function matchText(m: TagMatch): string {
  switch (m.state) {
    case 'exact':
      return `✓ 名字对上「${m.label}」`;
    case 'model':
      return `≈ 模型认成「${m.label}」(相似度 ${m.score.toFixed(2)})`;
    case 'pending':
      return '… 模型还在认';
    case 'failed':
      return `✗ ${m.reason},保持之前的表情`;
  }
}

function howText(x: VoiceExplain): string {
  switch (x.how) {
    case 'exact':
      return '名字对上';
    case 'alias':
      return `别名「${x.via ?? ''}」对上`;
    case 'nearest':
      return `情绪表里没有「${x.wanted ?? ''}」,模型挑了最像的「${x.via ?? ''}」(相似度 ${(x.score ?? 0).toFixed(2)})`;
    case 'default':
      return x.wanted ? `情绪表里没有「${x.wanted}」,模型也没挑出来,用排第一的默认情绪` : '没传情绪,用排第一的默认情绪';
  }
}

function clipText(st: ClipState | undefined): string {
  if (!st) return '这次打开还没放过这句';
  switch (st.state) {
    case 'queued':
      return '排队等合成';
    case 'loading':
      return '合成中…';
    case 'ready':
      return `✓ ${st.cache === 'hit' ? '缓存命中' : '新合成'} · ${(st.ms / 1000).toFixed(1)} 秒 · 用「${st.emotion}」的参考`;
    case 'error':
      return `✗ ${st.message}`;
  }
}

/** 请求体里除了文字和参考之外的那些(合成参数),一行写完 */
const REQ_SHOWN = new Set([
  'text',
  'text_lang',
  'lang',
  'ref_audio_path',
  'prompt_text',
  'prompt_lang',
  'spk_audio_path',
  'emo_audio_path',
  'emo_vector',
  'media_type',
  'streaming_mode',
]);
const paramsOf = (req: Record<string, unknown>) =>
  Object.entries(req)
    .filter(([k, v]) => !REQ_SHOWN.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

// ---- 参考音频试听:从语音服务那台机器上取回原声(后端转发,只放行这个声音配过的路径) ----

/** 取过的原声留在内存里,反复听不用再取;太多就丢掉最早的(一段不到 1 MB) */
const refAudio = new Map<string, Promise<ArrayBuffer>>();
const REF_KEEP = 12;
/** 正在放的是哪一段(播放器里只知道是 'preview') */
let refPlaying: string | null = null;

function loadRef(profileId: string, path: string): Promise<ArrayBuffer> {
  const key = `${profileId}
${path}`;
  let p = refAudio.get(key);
  if (!p) {
    p = debugApi.referenceAudio(profileId, path);
    // 失败的不留,下次重新取
    p.catch(() => refAudio.delete(key));
    refAudio.set(key, p);
    while (refAudio.size > REF_KEEP) refAudio.delete(refAudio.keys().next().value as string);
  }
  return p;
}

function RefPlay({ profileId, path }: { profileId: string; path: string }) {
  const snap = useVoice();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${profileId}
${path}`;
  const playing = snap.speaking === 'preview' && refPlaying === key;

  const click = async () => {
    if (playing) {
      voicePlayer.stop();
      return;
    }
    // 在点击里解锁:取原声要一会儿,回来就不算用户手势了
    bgmPlayer.unlock();
    setLoading(true);
    setError(null);
    try {
      const audio = await loadRef(profileId, path);
      refPlaying = key;
      await voicePlayer.playBuffer(audio);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`vn-vd-play${playing ? ' on' : ''}`}
        onClick={() => void click()}
        disabled={loading}
        aria-label={playing ? '停' : '听参考原声'}
        title={playing ? '停' : '听这段参考的原声'}
      >
        {loading ? '…' : playing ? '■' : '▶'}
      </button>
      {error && <span className="vn-vd-err">{error}</span>}
    </>
  );
}

export function VoiceDetail({
  line,
  index,
  hits,
  emotionBefore,
  plan,
  profile,
  ctx,
  voiceEnabled,
  fixedEmotion,
  streamingLast,
  onJump,
}: Props) {
  const snap = useVoice();
  const planKey = plan ? voiceKey(plan) : null;
  const [ex, setEx] = useState<{ key: string; data?: VoiceExplain; error?: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  // plan 每次重算都是新对象,按它的内容取;nonce 变了是「重新检查」
  const pid = plan?.profile_id ?? null;
  const wanted = plan?.emotion ?? null;
  const said = plan?.text ?? null;
  useEffect(() => {
    if (pid === null || said === null) return;
    const req = { profile_id: pid, emotion: wanted, text: said };
    const key = voiceKey(req);
    let live = true;
    debugApi
      .explainVoice(req)
      .then((data) => live && setEx({ key, data }))
      .catch((e: unknown) => live && setEx({ key, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [pid, wanted, said, nonce]);

  const explain = ex && ex.key === planKey ? ex : null;
  const x = explain?.data;

  // ---- 表情:这条回复里到这句为止最后一个立绘标签,以及它认成了什么 ----
  const tags = spriteHitsUpTo(hits, index, ctx.charName);
  const lastTag = tags[tags.length - 1];
  const effective = spriteLabelAfter(tags, ctx, emotionBefore);
  const own = hits.filter((h) => h.kind === 'sprite' && h.lineIndex === index);

  // [名字, 显示的内容, 悬停看到的全文, 能试听的参考音频路径]
  const rows: [string, string, string?, string?][] = [];
  rows.push([
    '说话人',
    line.player
      ? `${line.speaker}(玩家台词)`
      : line.untagged
        ? '(没写立绘标签,不算角色的)'
        : (line.speaker ?? '旁白'),
  ]);
  if (profile) rows.push(['声音', `${profile.name} · 念${langName(profile.text_lang)}`]);
  rows.push([
    '这句的标签',
    own.length ? own.map((h) => h.raw).join(' ') : '没有(立绘标签不在这句上)',
  ]);
  rows.push([
    '立绘标签',
    lastTag
      ? `${lastTag.raw}(第 ${lastTag.lineIndex + 1} 句)→ ${matchText(ctx.resolve(lastTag.label))}`
      : `这条回复里这句之前没有立绘标签,沿用之前的「${emotionBefore ?? '无'}」`,
  ]);
  rows.push(['生效的表情', effective ?? '无']);

  if (!voiceEnabled) {
    rows.push(['语音', '语音插件关着']);
  } else if (!plan) {
    rows.push([
      '语音',
      voiceSkipReason(line, profile, {
        streamingLast,
        pendingTag: !fixedEmotion && tags.some((h) => ctx.resolve(h.label).state === 'pending'),
      }),
    ]);
  } else {
    rows.push([
      '要的情绪',
      plan.emotion ??
        (fixedEmotion ? '不传(插件设置里语音情绪选了不变,用默认情绪)' : '不传(不是主声音,用它的默认情绪)'),
    ]);
    if (explain?.error) {
      rows.push(['后端', `✗ ${explain.error}`]);
    } else if (!x) {
      rows.push(['后端', '正在问…']);
    } else {
      const req = x.request;
      rows.push(['用的情绪行', x.emotion ? `「${x.emotion}」· ${howText(x)}` : `(没有情绪行)· ${howText(x)}`]);
      if (x.api_type === 'indextts') {
        const spk = str(req.spk_audio_path);
        rows.push(['音色参考', baseName(spk), spk, spk || undefined]);
        rows.push([
          '情绪来源',
          x.mode === 'ref'
            ? `参考音频 ${baseName(str(req.emo_audio_path))}`
            : x.mode === 'vector'
              ? `情绪向量 ${str(req.emo_vector)}`
              : '不控制(沿用音色参考的语气)',
          x.mode === 'ref' ? str(req.emo_audio_path) : undefined,
          x.mode === 'ref' ? str(req.emo_audio_path) : undefined,
        ]);
        rows.push(['念的文字', `${str(req.text)}(${langName(str(req.lang))})`]);
      } else {
        const ref = str(req.ref_audio_path);
        rows.push(['参考音频', baseName(ref), ref, ref || undefined]);
        rows.push(['参考原文', `${str(req.prompt_text)}(${langName(str(req.prompt_lang))})`]);
        rows.push(['念的文字', `${str(req.text)}(${langName(str(req.text_lang))})`]);
        rows.push(['模型', `${baseName(x.gpt_weights)} / ${baseName(x.sovits_weights)}`, `${x.gpt_weights}\n${x.sovits_weights}`]);
      }
      rows.push(['合成参数', paramsOf(req) || '—']);
      rows.push(['语音服务', x.connection_name]);
      rows.push(['缓存', x.cached ? '合成过,缓存里有(重播直接出)' : '还没合成过']);
    }
    rows.push(['这次播放', clipText(snap.clips.get(voiceKey(plan)))]);
  }

  const copy = async () => {
    const text = [
      line.text,
      ...(line.ja ? [`日语:${line.ja}`] : []),
      ...rows.map(([k, v, full]) => `${k}:${full && full !== v ? full.replace(/\n/g, ' ') : v}`),
      ...(x ? ['发给语音服务的请求:', JSON.stringify(x.request, null, 2)] : []),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    window.setTimeout(() => setCopied(null), 1600);
  };

  return (
    <div className="vn-vd">
      <dl className="vn-vd-grid">
        {rows.map(([k, v, full, ref]) => (
          <div key={k} className="vn-vd-row">
            <dt>{k}</dt>
            <dd title={full}>
              {ref && pid && <RefPlay profileId={pid} path={ref} />}
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {x && (
        <details className="vn-vd-raw">
          <summary>发给语音服务的原样请求</summary>
          <pre>{JSON.stringify(x.request, null, 2)}</pre>
        </details>
      )}
      <div className="vn-vd-actions">
        <button type="button" className="vn-pill" onClick={() => void copy()}>
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制详情'}
        </button>
        {plan && (
          <button type="button" className="vn-pill" onClick={() => setNonce((n) => n + 1)} title="声音或情绪表改过之后重新问一遍">
            重新检查
          </button>
        )}
        <button type="button" className="vn-pill accent" onClick={onJump}>
          回到这里
        </button>
      </div>
    </div>
  );
}
