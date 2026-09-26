/**
 * 语音播放器(全局单例)。视觉小说界面告诉它「接下来要念哪几句」,它按顺序一次发一个
 * 合成请求(服务端本来就是串行的),合成好的音频留在内存里,翻到那句时播。
 * 玩家点的重播 / 重新生成插到最前面,换句也不丢。
 *
 * 和 BGM 共用一个 AudioContext(bgm.ts):iOS 只要解锁一次;念台词时顺手把 BGM 压低。
 * 后端有缓存,这里只留最近几十句,重播时内存里没了也只是多一次命中缓存的请求。
 */

import { useSyncExternalStore } from 'react';
import { debugApi, type EmoMode, type SpeakRequest } from '../lib/api';
import { voiceKey } from '../plugins/voice';
import { bgmPlayer } from './bgm';

const STORE_KEY = 'anima.vn.voice';
/** 内存里最多留几句 */
const MAX_CLIPS = 40;
/** 连续失败几句就先停用语音(这次进视觉小说期间) */
export const MAX_FAILURES = 3;

export type ClipState =
  | { state: 'queued' }
  | { state: 'loading' }
  | { state: 'ready'; cache: 'hit' | 'miss'; emotion: string; mode: EmoMode; ms: number }
  | { state: 'error'; message: string };

interface Clip {
  req: SpeakRequest;
  status: ClipState;
  audio: ArrayBuffer | null;
  /** 重新生成:这次不用后端缓存 */
  fresh: boolean;
}

export interface VoiceSnapshot {
  volume: number;
  muted: boolean;
  /** 正在出声的那句(voiceKey);试听时是 'preview' */
  speaking: string | null;
  /** 每句的状态,控制台和「等语音」用 */
  clips: ReadonlyMap<string, ClipState>;
  /** 连续失败了几句 */
  failures: number;
  lastError: string | null;
}

class VoicePlayer {
  private clips = new Map<string, Clip>();
  /** 还没发出去的请求,按优先级排 */
  private queue: string[] = [];
  /** 玩家点了重播 / 重新生成、还没合成完的句子:want() 换句时不丢 */
  private pinned = new Set<string>();
  private busy = false;
  /** play() 要的那句:好了就放 */
  private wanted: string | null = null;
  /** 正在解码准备开播的那句,防止同一句被放两遍 */
  private starting: string | null = null;
  private current: { key: string; source: AudioBufferSourceNode } | null = null;
  private out: GainNode | null = null;
  private listeners = new Set<() => void>();
  private snap: VoiceSnapshot = {
    volume: 0.9,
    muted: false,
    speaking: null,
    clips: new Map(),
    failures: 0,
    lastError: null,
  };

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as {
        volume?: unknown;
        muted?: unknown;
      } | null;
      if (saved && typeof saved.volume === 'number') {
        this.snap.volume = Math.min(1, Math.max(0, saved.volume));
      }
      if (saved && typeof saved.muted === 'boolean') this.snap.muted = saved.muted;
    } catch {
      // 隐私模式等拿不到 localStorage,用默认音量
    }
  }

  // ---- 给 React 订阅 ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<VoiceSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }
  private publish() {
    this.set({ clips: new Map([...this.clips].map(([k, c]) => [k, c.status])) });
  }

  private get disabled() {
    return this.snap.failures >= MAX_FAILURES;
  }

  // ---- 控制 ----

  /**
   * 接下来要念的几句,当前句在最前。没发出去的旧请求丢掉,已经发出去的照常完成。
   * 流式时每来一个字都会调一次,内容没变就不通知订阅者,免得白白重渲染
   */
  want(reqs: SpeakRequest[]) {
    let changed = false;
    const next: string[] = [];
    for (const r of reqs) {
      const key = voiceKey(r);
      const clip = this.clips.get(key);
      if (!clip) {
        this.clips.set(key, { req: r, status: { state: 'queued' }, audio: null, fresh: false });
        changed = true;
      }
      if ((!clip || clip.status.state === 'queued') && !this.pinned.has(key)) next.push(key);
    }
    for (const [k, c] of this.clips) {
      if (c.status.state === 'queued' && !next.includes(k) && !this.pinned.has(k)) {
        this.clips.delete(k);
        changed = true;
      }
    }
    const kept = this.queue.filter((k) => this.pinned.has(k));
    this.queue = [...kept, ...next];
    if (changed) this.publish();
    void this.pump();
  }

  /** 放这句:现在好了就放,没好就等好了再放。换句时先 stop() */
  play(key: string) {
    this.wanted = key;
    void this.startIfReady();
  }

  /** 不再等之前要的那句,但正在念的接着念(翻页不打断语音时用) */
  cancelPending() {
    this.wanted = null;
  }

  /** 停掉正在念的,也不再等之前要的那句 */
  stop() {
    this.wanted = null;
    this.stopSource();
  }

  /**
   * 重播:内存里还有就直接放;没有、上次失败了、还在排队就插到最前面去请求
   * (合成过的后端有缓存,很快)
   */
  replay(req: SpeakRequest) {
    const key = voiceKey(req);
    this.stop();
    const clip = this.clips.get(key);
    if (!clip || clip.status.state === 'error' || clip.status.state === 'queued') {
      this.requestNow(req, clip?.status.state === 'queued' && clip.fresh);
    }
    this.play(key);
  }

  /**
   * 重新生成:不用缓存再合成一遍,好了就放。api_v2 每次的随机种子不同,
   * 所以是换一种念法;新的替换缓存里的旧版。正在合成的那句不接受
   */
  regenerate(req: SpeakRequest) {
    const key = voiceKey(req);
    if (this.clips.get(key)?.status.state === 'loading') return;
    this.stop();
    this.requestNow(req, true);
    this.play(key);
  }

  /** 清掉失败记录:失败太多停用之后点「重试」,或者重新进视觉小说 */
  reset() {
    for (const [k, c] of this.clips) {
      // 停用时丢掉的排队请求也清掉,不然一直显示「排队中」
      const stale = c.status.state === 'queued' && !this.queue.includes(k);
      if (c.status.state === 'error' || stale) this.clips.delete(k);
    }
    this.set({ failures: 0, lastError: null });
    this.publish();
  }

  /** 停用期间探测语音服务又失败了:只更新原因(比如从「隧道没开」变成「服务没启动」),不动失败计数 */
  noteProbeFailure(message: string) {
    this.set({ lastError: message });
  }

  /**
   * 这些声音的设置改了(参数、参考、权重……):内存里合成好的句子作废。视觉小说接着要念的
   * 由 want() 重新排上(声音列表一刷新,每句怎么念会重算);后端的缓存键跟着设置变,会重新合成。
   * 正在合成的那句回来时已经不在表里,结果直接扔掉
   */
  forget(profileIds: ReadonlySet<string>) {
    let changed = false;
    for (const [k, c] of this.clips) {
      if (!profileIds.has(c.req.profile_id)) continue;
      this.clips.delete(k);
      this.pinned.delete(k);
      changed = true;
    }
    if (!changed) return;
    this.queue = this.queue.filter((k) => this.clips.has(k));
    this.publish();
  }

  /** 离开视觉小说:停掉,没发出去的请求都不要了(已经发出去的照常完成) */
  idle() {
    this.stop();
    this.pinned.clear();
    this.want([]);
  }

  /** 直接放一段音频(插件页的试听)。调用方要先在点击里 bgmPlayer.unlock() */
  async playBuffer(audio: ArrayBuffer) {
    const ctx = bgmPlayer.context;
    if (!ctx) throw new Error('浏览器还没允许出声,先点一下页面再试');
    if (ctx.state !== 'running') await ctx.resume();
    const buffer = await ctx.decodeAudioData(audio.slice(0));
    this.wanted = null;
    this.startBuffer('preview', buffer);
  }

  setVolume(v: number) {
    this.set({ volume: Math.min(1, Math.max(0, v)) });
    this.applyLevel();
  }

  setMuted(m: boolean) {
    this.set({ muted: m });
    this.applyLevel();
  }

  // ---- 内部 ----

  /** 玩家点的:插到队首,钉住 */
  private requestNow(req: SpeakRequest, fresh: boolean) {
    const key = voiceKey(req);
    this.clips.set(key, { req, status: { state: 'queued' }, audio: null, fresh });
    this.pinned.add(key);
    this.queue = [key, ...this.queue.filter((k) => k !== key)];
    this.publish();
    void this.pump();
  }

  private async pump() {
    if (this.busy || this.disabled) return;
    const key = this.queue.shift();
    if (!key) return;
    const clip = this.clips.get(key);
    if (!clip || clip.status.state !== 'queued') {
      void this.pump();
      return;
    }
    this.busy = true;
    clip.status = { state: 'loading' };
    this.publish();
    try {
      const r = await debugApi.speak(clip.req, clip.fresh);
      clip.audio = r.audio;
      clip.status = { state: 'ready', cache: r.cache, emotion: r.emotion, mode: r.mode, ms: r.ms };
      this.set({ failures: 0, lastError: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      clip.status = { state: 'error', message };
      this.set({ failures: this.snap.failures + 1, lastError: message });
      if (this.disabled) {
        this.queue = [];
        this.pinned.clear();
      }
    } finally {
      this.busy = false;
      clip.fresh = false;
      this.pinned.delete(key);
    }
    this.trim();
    this.publish();
    void this.startIfReady();
    void this.pump();
  }

  private async startIfReady() {
    const key = this.wanted;
    const ctx = bgmPlayer.context;
    if (!key || !ctx || this.starting === key || this.current?.key === key) return;
    const clip = this.clips.get(key);
    if (!clip?.audio) return;
    this.starting = key;
    let buffer: AudioBuffer;
    try {
      // decodeAudioData 会把传进去的 ArrayBuffer 用掉,传一份拷贝,重播时还能再解
      buffer = await ctx.decodeAudioData(clip.audio.slice(0));
    } catch {
      clip.status = { state: 'error', message: '语音解码失败' };
      this.publish();
      return;
    } finally {
      this.starting = null;
    }
    if (this.wanted !== key) return; // 解码的这点时间里换句了
    this.wanted = null;
    this.startBuffer(key, buffer);
  }

  private startBuffer(key: string, buffer: AudioBuffer) {
    const ctx = bgmPlayer.context;
    if (!ctx) return;
    this.stopSource();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output(ctx));
    source.onended = () => {
      if (this.current?.source !== source) return;
      this.current = null;
      bgmPlayer.duck(false);
      this.set({ speaking: null });
    };
    source.start();
    this.current = { key, source };
    bgmPlayer.duck(true);
    this.set({ speaking: key });
  }

  private stopSource() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.source.onended = null;
    try {
      cur.source.stop();
    } catch {
      // 已经停了
    }
    cur.source.disconnect();
    bgmPlayer.duck(false);
    this.set({ speaking: null });
  }

  private output(ctx: AudioContext): GainNode {
    if (!this.out || this.out.context !== ctx) {
      this.out = ctx.createGain();
      this.out.gain.value = this.level();
      this.out.connect(ctx.destination);
    }
    return this.out;
  }

  /** 和 BGM 一样:滑条线性,听感对数,平方一下 */
  private level() {
    return this.snap.muted ? 0 : this.snap.volume * this.snap.volume;
  }

  private applyLevel() {
    if (this.out) this.out.gain.setTargetAtTime(this.level(), this.out.context.currentTime, 0.05);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ volume: this.snap.volume, muted: this.snap.muted }));
    } catch {
      // 存不了就只在这次打开里生效
    }
  }

  /** 内存里的句子太多时,从最早的删起;排队中、合成中、正在放、等着放的不删 */
  private trim() {
    for (const [k, c] of this.clips) {
      if (this.clips.size <= MAX_CLIPS) break;
      const live = c.status.state === 'queued' || c.status.state === 'loading';
      if (live || k === this.current?.key || k === this.wanted) continue;
      this.clips.delete(k);
    }
  }
}

export const voicePlayer = new VoicePlayer();

export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(voicePlayer.subscribe, voicePlayer.getSnapshot);
}
