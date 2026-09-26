/**
 * 背景音乐播放器(全局单例,视觉小说界面和插件抽屉的试听共用)。
 *
 * 用 Web Audio(fetch → decodeAudioData → AudioBufferSourceNode)而不是 <audio>:
 *   - iOS Safari 不许网页改 <audio> 的音量,淡入淡出只能靠 GainNode
 *   - <audio> 每次 play() 都要有用户手势;AudioContext 只要在点击里解锁一次,
 *     之后 AI 回复里换曲子,不用再点就能响
 *   - 整首解码后循环是无缝的,<audio loop> 的 MP3 在接缝处会顿一下
 * 代价是解码后的 PCM 比较占内存(一首三分钟的曲子几十 MB),所以只缓存最近几首。
 */

import { useSyncExternalStore } from 'react';

/** 换歌时交叉淡入淡出的秒数 */
const FADE = 1.5;
/** 解码后的曲子最多留几首 */
const MAX_BUFFERS = 3;
const STORE_KEY = 'anima.vn.audio';
/** 念台词时 BGM 压到原音量的多少 */
/** 念台词时 BGM 默认压到原音量的 35%;设置里可以改 */
const DEFAULT_DUCK_LEVEL = 0.35;

interface Track {
  url: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface BgmSnapshot {
  /** 最后一次要求播放的曲子(还在下载 / 解码时也算) */
  wanted: string | null;
  /** 正在出声的曲子 */
  playing: string | null;
  /** 插件页正在试听的曲子(视觉小说里场景自己在放的不算) */
  preview: string | null;
  volume: number;
  muted: boolean;
  /** 下载或解码失败的曲子 → 原因 */
  error: string | null;
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

class BgmPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 串在 master 后面,念台词时压低 BGM;和音量滑条分开,互不影响 */
  private duckGain: GainNode | null = null;
  private duckLevel = DEFAULT_DUCK_LEVEL;
  private ducked = false;
  private current: Track | null = null;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private active = false;
  /** 插件页试听之前在放什么:停止试听时还原(在视觉小说菜单里试听完,场景的曲子接着放) */
  private beforePreview: { wanted: string | null; active: boolean } | null = null;
  private suspendTimer: number | undefined;
  private listeners = new Set<() => void>();
  private snap: BgmSnapshot = {
    wanted: null,
    playing: null,
    preview: null,
    volume: 0.7,
    muted: false,
    error: null,
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
    if (typeof document !== 'undefined') {
      // 切到后台就停,回来接着放(手机锁屏、切 App 时不该一直响)
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) void this.ctx.suspend().catch(() => {});
        else if (this.active) void this.ctx.resume().catch(() => {});
      });
    }
  }

  // ---- 给 React 订阅 ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;
  private set(patch: Partial<BgmSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---- 控制 ----

  /**
   * 在用户手势(点击、按键)里调用:第一次会创建 AudioContext,之后每次确保它在运行。
   * iOS 上 AudioContext 只能在手势里启动;锁屏回来后也可能被系统挂起,要再点一下。
   */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.level();
      this.duckGain = this.ctx.createGain();
      this.master.connect(this.duckGain);
      this.duckGain.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running' && !document.hidden) void this.ctx.resume().catch(() => {});
    // 解锁之前就要求过的曲子,现在补上
    void this.sync();
  }

  /** 视觉小说界面打开 / 关闭(关闭时淡出,淡完挂起,不占声卡) */
  setActive(on: boolean) {
    this.active = on;
    window.clearTimeout(this.suspendTimer);
    if (on) {
      if (this.ctx && this.ctx.state !== 'running' && !document.hidden) {
        void this.ctx.resume().catch(() => {});
      }
      return;
    }
    this.play(null);
    this.suspendTimer = window.setTimeout(() => {
      if (!this.active) void this.ctx?.suspend().catch(() => {});
    }, FADE * 1000 + 300);
  }

  /** 试听一首(插件页)。要在点击里调:顺手解锁 */
  startPreview(url: string) {
    this.beforePreview ??= { wanted: this.snap.wanted, active: this.active };
    this.set({ preview: url });
    this.unlock();
    this.setActive(true);
    this.play(url);
  }

  /** 停止试听,还原成试听之前的样子。没在试听时什么也不做 */
  stopPreview() {
    const before = this.beforePreview;
    if (!before) return;
    this.beforePreview = null;
    this.set({ preview: null });
    // 试听期间视觉小说关了(先于插件页卸载)的话,this.active 已经是 false,别再放出声来
    if (before.active && this.active) this.play(before.wanted);
    else this.setActive(false);
  }

  /** 换成这首(null = 淡出到静音)。和正在放的是同一首时什么也不做 */
  play(url: string | null) {
    if (url === this.snap.wanted) return;
    this.set({ wanted: url, error: null });
    void this.sync();
  }

  /** 提前下载 + 解码,切过去时不用等 */
  prefetch(url: string) {
    if (this.ctx) {
      void this.load(url).catch(() => {});
    } else {
      // 还没解锁就没有 AudioContext 可以解码,先把文件拉进浏览器缓存
      void fetch(url).catch(() => {});
    }
  }

  setVolume(v: number) {
    this.set({ volume: Math.min(1, Math.max(0, v)) });
    this.applyLevel();
  }

  setMuted(m: boolean) {
    this.set({ muted: m });
    this.applyLevel();
  }

  /** 语音播放器和 BGM 共用这个 AudioContext(iOS 只用解锁一次)。还没解锁时是 null */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** 念台词时 BGM 压到多少(1 = 不压)。正压着的时候改,立刻按新值压 */
  setDuckLevel(v: number) {
    this.duckLevel = Math.min(1, Math.max(0, v));
    if (this.ducked) this.duck(true);
  }

  /** 念台词时把 BGM 压低(默认 35%),念完 0.5 秒内淡回 */
  duck(on: boolean) {
    this.ducked = on;
    if (!this.ctx || !this.duckGain) return;
    const g = this.duckGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(on ? this.duckLevel : 1, now, on ? 0.08 : 0.15);
  }

  // ---- 内部 ----

  /** 滑条是线性的,耳朵听响度是对数的:平方一下,滑条中间听起来才像「一半」 */
  private level() {
    return this.snap.muted ? 0 : this.snap.volume * this.snap.volume;
  }

  private applyLevel() {
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05);
    }
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ volume: this.snap.volume, muted: this.snap.muted }),
      );
    } catch {
      // 存不了就只在这次打开里生效
    }
  }

  private load(url: string): Promise<AudioBuffer> {
    const hit = this.buffers.get(url);
    if (hit) {
      // 挪到最后 = 最近用过
      this.buffers.delete(url);
      this.buffers.set(url, hit);
      return hit;
    }
    const ctx = this.ctx!;
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`下载失败(HTTP ${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => ctx.decodeAudioData(buf));
    p.catch(() => this.buffers.delete(url));
    this.buffers.set(url, p);
    while (this.buffers.size > MAX_BUFFERS) {
      const oldest = this.buffers.keys().next().value as string;
      this.buffers.delete(oldest);
    }
    return p;
  }

  private async sync() {
    const url = this.snap.wanted;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return; // 还没解锁;unlock() 会再调一次
    if ((this.current?.url ?? null) === url) return;
    if (url === null) {
      this.fadeOut();
      this.set({ playing: null });
      return;
    }

    let buffer: AudioBuffer;
    try {
      buffer = await this.load(url);
    } catch (e) {
      if (this.snap.wanted === url) {
        this.set({ error: e instanceof Error ? e.message : '这首曲子解码失败(格式不支持?)' });
      }
      return;
    }
    // 下载 / 解码的这段时间里又换了曲子,或者别的 sync 已经把它放上了
    if (this.snap.wanted !== url || this.current?.url === url) return;

    this.fadeOut();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE);
    gain.connect(master);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    this.current = { url, source, gain };
    this.set({ playing: url });
  }

  private fadeOut() {
    const t = this.current;
    const ctx = this.ctx;
    if (!t || !ctx) return;
    this.current = null;
    const now = ctx.currentTime;
    t.gain.gain.cancelScheduledValues(now);
    t.gain.gain.setValueAtTime(t.gain.gain.value, now);
    t.gain.gain.linearRampToValueAtTime(0, now + FADE);
    t.source.onended = () => t.gain.disconnect();
    t.source.stop(now + FADE + 0.05);
  }
}

export const bgmPlayer = new BgmPlayer();

export function useBgm(): BgmSnapshot {
  return useSyncExternalStore(bgmPlayer.subscribe, bgmPlayer.getSnapshot);
}
