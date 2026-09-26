/**
 * 视觉小说里「当前这句」的语音:预合成、换句时停、「等语音」的闸门、失败太多时暂停、预热。
 * 规则见 docs/superpowers/specs/2026-09-24-vn-voice-design.md 的「播放」一节。
 */

import { useEffect, useState } from 'react';
import { debugApi, type SpeakRequest } from '../lib/api';
import { voiceKey, type VoicePluginConfig } from '../plugins/voice';
import { MAX_FAILURES, useVoice, voicePlayer, type ClipState } from './voice';

/** 同一个声音多久内不重复预热(开发时 StrictMode 会把 effect 跑两遍) */
const WARMUP_DEDUPE_MS = 10_000;
/** 连续失败停用之后,多久探测一次语音服务(台式机开机、服务启动之后自己接上) */
export const PROBE_INTERVAL_MS = 15_000;
const warmedAt = new Map<string, number>();

function warmup(profileId: string) {
  const last = warmedAt.get(profileId) ?? 0;
  if (Date.now() - last < WARMUP_DEDUPE_MS) return;
  warmedAt.set(profileId, Date.now());
  void debugApi.warmupVoice(profileId).catch(() => {});
}

export interface VoiceLine {
  /** 当前这句念什么;不念是 null */
  request: SpeakRequest | null;
  /** 每句的状态(控制台用) */
  clips: ReadonlyMap<string, ClipState>;
  /** 等语音:还没好,先别开始打字 */
  gated: boolean;
  /** 当前这句要念、语音还在合成 —— 不等语音时,对话框里文字后面转个圈 */
  synthesizing: boolean;
  /**
   * 不等了,先出文字(等的时候点了一下对话框)。点重播 / 重新生成时也要调:
   * 不然这句又回到「合成中」,闸门会把已经打出来的字收回去
   */
  release: () => void;
  /** 当前这句正在出声 —— 自动播放等它念完再翻 */
  speaking: boolean;
  /** 连续失败太多,先停用了;停用期间每 15 秒探测一次,通了自动恢复 */
  paused: boolean;
  lastError: string | null;
  /** 清掉失败记录,重新预热 */
  retry: () => void;
}

interface Options {
  config: VoicePluginConfig;
  /** 当前这条回复里每句怎么念(planVoiceLines 的结果) */
  plans: readonly (SpeakRequest | null)[];
  line: number;
  /** 当前这句的标识,换句就变 */
  lineKey: string;
  /** 跳过中、标题画面盖着时不念 */
  silent: boolean;
  /** 主声音:进视觉小说时预热它 */
  warmupId: string | null;
  /** 主声音用的语音服务:停用之后定时探测它,通了就自动恢复 */
  probeConnectionId: string | null;
  /** 翻页时停掉上一句;false = 上一句接着念,直到这句的语音开始 */
  interrupt: boolean;
}

export function useVoiceLine({
  config,
  plans,
  line,
  lineKey,
  silent,
  warmupId,
  probeConnectionId,
  interrupt,
}: Options): VoiceLine {
  const snap = useVoice();
  const paused = snap.failures >= MAX_FAILURES;
  const active = config.enabled && !paused;
  const request = active ? (plans[line] ?? null) : null;
  const key = request ? voiceKey(request) : null;

  // 进来时清掉上次留下的失败记录;离开时停掉,没发出去的请求也不要了
  useEffect(() => {
    voicePlayer.reset();
    return () => voicePlayer.idle();
  }, []);

  // 预热主声音:服务刚启动时第一次合成要 40 秒左右,趁玩家还在看标题画面时做掉
  useEffect(() => {
    if (config.enabled && warmupId) warmup(warmupId);
  }, [config.enabled, warmupId]);

  // 停用之后定时探测语音服务(只请求 /docs,很轻):通了就清掉失败记录、重新预热,
  // 预合成跟着恢复 —— 台式机开机、服务启动之后不用手动点重试
  const probing = config.enabled && paused && probeConnectionId !== null;
  useEffect(() => {
    if (!probing || probeConnectionId === null) return;
    let alive = true;
    const probe = () =>
      debugApi.testTtsConnection(probeConnectionId).then(
        () => {
          if (!alive) return;
          voicePlayer.reset();
          if (warmupId) {
            warmedAt.delete(warmupId);
            warmup(warmupId);
          }
        },
        (err: unknown) => {
          if (alive) voicePlayer.noteProbeFailure(err instanceof Error ? err.message : String(err));
        },
      );
    const t = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [probing, probeConnectionId, warmupId]);

  // 预合成:当前句排最前,这条回复后面要念的全都排上 —— 玩家看前几句的时候服务端
  // 别闲着,点得快也不容易追上。流式时每来一个字都会重跑,内容没变的话 want() 什么也不做
  useEffect(() => {
    const upcoming: SpeakRequest[] = [];
    if (active && !silent) {
      for (let i = line; i < plans.length; i++) {
        const r = plans[i];
        if (r) upcoming.push(r);
      }
    }
    voicePlayer.want(upcoming);
  }, [active, silent, plans, line]);

  // 换句:停掉上一句(设置里关了「翻页停语音」就让它念完,这句的语音一开始自然换掉它;
  // 跳过时照样停);这句要念就「好了就放」—— 现在没好,好了再补上
  useEffect(() => {
    if (interrupt || silent) voicePlayer.stop();
    else voicePlayer.cancelPending();
    if (key && !silent) voicePlayer.play(key);
  }, [lineKey, key, silent, interrupt]);

  // ---- 等语音 ----

  const status = key ? (snap.clips.get(key) ?? null) : null;
  // want() 在渲染之后才跑,还没进表的也算没好,免得先打出一个字又收回去
  const pending =
    key !== null && (status === null || status.state === 'queued' || status.state === 'loading');

  // 只在「进这句时就要念」的句子上等:流式时一句写完才知道要念,那时字已经出来了,不能收回
  const [entered, setEntered] = useState({ lineKey, key });
  if (entered.lineKey !== lineKey) setEntered({ lineKey, key });
  const enteredKey = entered.lineKey === lineKey ? entered.key : key;

  const [released, setReleased] = useState<string | null>(null);
  const gated =
    config.waitForVoice &&
    !silent &&
    key !== null &&
    key === enteredKey &&
    pending &&
    released !== lineKey;

  useEffect(() => {
    if (!gated) return;
    const t = window.setTimeout(() => setReleased(lineKey), config.maxWaitSec * 1000);
    return () => window.clearTimeout(t);
  }, [gated, lineKey, config.maxWaitSec]);

  return {
    request,
    clips: snap.clips,
    gated,
    synthesizing: key !== null && !silent && pending,
    release: () => setReleased(lineKey),
    speaking: key !== null && snap.speaking === key,
    paused: config.enabled && paused,
    lastError: snap.lastError,
    retry: () => {
      voicePlayer.reset();
      if (warmupId) {
        warmedAt.delete(warmupId);
        warmup(warmupId);
      }
    },
  };
}
