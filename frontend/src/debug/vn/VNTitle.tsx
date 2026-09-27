/**
 * 标题画面(Beta)。两种样式,设置「显示 → 封面样式」里切换:
 *
 *   海报:斜切两半。左边是上次停下的场景 + 立绘(出框、带点缀色投影),右边是纸面排版 ——
 *        纸面颜色从背景里取,夜景自动换深色纸;纸上淡淡印着她另一张表情的脸。
 *        左边一列(竖屏是底部一排)是库里的角色,点头像直接换人。
 *   电影:上下黑边的片头。场景包里的几个地方轮流淡入,每个镜头换一个表情、打一行地点,
 *        转一圈回到上次停下的地方,打出最后一句。「继续」时黑边收起、立绘挪到游戏里的位置,
 *        封面淡出,底下就是游戏本身。
 *
 * 两种都按脸摆立绘(titleArt.ts),鼠标移到菜单上她会换表情,点她一下会害羞。
 * 素材全从卡和场景包里来,不用给封面单独配什么。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cardFaceUrl, spriteImageUrl, type CardSprite, type SpriteLayout } from '../lib/api';
import { relTime } from '../lib/time';
import { spriteStyle, type FaceBox, type SpriteStage } from '../plugins/spriteLayout';
import { Feather } from './Feather';
import {
  accentOf,
  montageSprites,
  paperOf,
  spriteForMood,
  titleSpriteStyle,
  type Accent,
  type Paper,
  type TitleMood,
  type TitlePose,
} from './titleArt';
import type { TitleStyle } from './vnSettings';
import './vnTitle.css';

export interface TitleCard {
  id: string;
  name: string;
  avatar: string | null;
  /** 有上次玩到的对话 —— 点头像是接着上次,没有就开一段新的 */
  hasLastChat: boolean;
}

/** 一张背景 */
export interface TitleScene {
  key: string;
  src: string;
  /** 竖屏时对准横图的哪儿(object-position 的横向百分比) */
  focus: number;
  label: string;
}

interface Props {
  variant: TitleStyle;
  cardId: string | null;
  charName: string;
  /** 作品名:卡片的第一个标签 */
  tag: string | null;
  /** 当前对话最后一次改动的时间(后端的 updated_at) */
  lastPlayed: string | null;
  /** 最新一条回复里她说的最后一句 */
  lastLine: string | null;
  /** 启用的立绘,排第一的是默认表情 */
  sprites: CardSprite[];
  faces: Map<string, FaceBox>;
  /** 游戏里的构图 —— 电影「继续」时立绘挪到和游戏一模一样的位置 */
  spriteStage: SpriteStage;
  spriteLayout: SpriteLayout;
  /** 上次停下的地方 */
  home: TitleScene;
  /** 场景包里的背景,电影片头轮播 */
  scenes: TitleScene[];
  cards: TitleCard[];
  onContinue: () => void;
  /** 给当前角色开一段新对话 */
  onNewStory: () => void;
  /** 换成另一个角色(接着她上次的对话),封面不关 */
  onSwitchCard: (id: string) => void;
  onLoad: () => void;
  onSettings: () => void;
  onExit: () => void;
}

const DEFAULT_ACCENT: Accent = { acc: '#f4a9c4', deep: 'hsl(335 40% 38%)', ink: '#2b1420', rgb: '244, 169, 196' };

const MENU: { mood: TitleMood; zh: string; en: string }[] = [
  { mood: 'continue', zh: '继续', en: 'CONTINUE' },
  { mood: 'new', zh: '新的故事', en: 'NEW STORY' },
  { mood: 'load', zh: '读档', en: 'LOAD' },
  { mood: 'config', zh: '设置', en: 'CONFIG' },
];

/** 立绘摆法:海报的脸在左半边;电影的比游戏里低一点,给上面的黑边让位,「继续」时再升上去 */
const POSES: Record<TitleStyle, { land: TitlePose; port: TitlePose }> = {
  poster: {
    land: { faceSize: 0.23, faceTop: 0.16, cx: 0.36 },
    port: { faceSize: 0.13, faceTop: 0.12, cx: 0.5, floor: 0.62 },
  },
  cinema: {
    land: { faceSize: 0.2, faceTop: 0.16, cx: 0.5 },
    port: { faceSize: 0.14, faceTop: 0.12, cx: 0.5 },
  },
};

/** 片头每个镜头停多久;第一镜(上次的地方)多停一会儿,让最后一句打完 */
const SHOT_MS = 6500;
const HOME_MS = 10000;
/** 片头最多轮几个地方(含上次的地方) */
const MAX_SHOTS = 5;

const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** 异步取色的结果;换图时先留着上一张的颜色,新的算好再换(CSS 里有过渡),不闪默认色 */
function useLoaded<T>(src: string | null, load: (src: string) => Promise<T | null>): T | null {
  const [got, setGot] = useState<T | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    void load(src).then((v) => {
      if (alive) setGot(v);
    });
    return () => {
      alive = false;
    };
  }, [src, load]);
  return got;
}

interface Layer {
  key: string;
  src: string;
  style: CSSProperties;
}

/** 换表情:新图叠上去淡入,旧图淡出后摘掉(和游戏里的 SpriteLayer 同一个做法) */
function SpriteStack({ layer, onPoke }: { layer: Layer | null; onPoke: () => void }) {
  const [layers, setLayers] = useState<{ cur: Layer | null; prev: Layer | null }>({ cur: layer, prev: null });
  useEffect(() => {
    if (layer?.key !== layers.cur?.key) setLayers({ cur: layer, prev: layers.cur });
    else if (layer !== layers.cur) setLayers((l) => ({ ...l, cur: layer }));
  }, [layer, layers.cur]);
  useEffect(() => {
    if (!layers.prev) return;
    const t = window.setTimeout(() => setLayers((l) => ({ ...l, prev: null })), 340);
    return () => window.clearTimeout(t);
  }, [layers.prev]);
  const img = (l: Layer, cls: string) => (
    <img
      key={l.key}
      className={`vn-tt-spr ${cls}`}
      src={l.src}
      style={l.style}
      alt=""
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        onPoke();
      }}
    />
  );
  return (
    <>
      {layers.prev && img(layers.prev, 'leaving')}
      {layers.cur && img(layers.cur, layers.prev ? 'entering' : '')}
    </>
  );
}

/** 角色头像:后端按脸裁的小图 → 卡面头像 → 名字首字 */
function Face({ card, current, onPick }: { card: TitleCard; current: boolean; onPick: () => void }) {
  const [src, setSrc] = useState<string | null>(() => cardFaceUrl(card.id, 128));
  return (
    <button
      className={`vn-tt-face${current ? ' current' : ''}`}
      onClick={onPick}
      aria-label={card.name}
      aria-current={current || undefined}
      title={current ? card.name : `${card.name} · ${card.hasLastChat ? '接着上次' : '开始新故事'}`}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className={src === card.avatar ? 'avatar' : ''}
          onError={() => setSrc((s) => (s !== card.avatar ? card.avatar : null))}
        />
      ) : (
        <span className="vn-tt-face-ph">{card.name.slice(0, 1) || '?'}</span>
      )}
      <span className="vn-tt-face-tip">{card.name}</span>
    </button>
  );
}

/** 电影片头里飘的光点,颜色跟角色的点缀色 */
function Motes({ rgb }: { rgb: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx || reduceMotion) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0;
    let H = 0;
    const fit = () => {
      W = cv.width = cv.clientWidth * dpr;
      H = cv.height = cv.clientHeight * dpr;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    const spawn = (anywhere: boolean) => ({
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : H + 10,
      r: (0.15 + Math.random() * 0.45) * (H / 100),
      v: (0.6 + Math.random() * 1.6) * (H / 100),
      ph: Math.random() * 6.28,
      sway: (0.4 + Math.random()) * (H / 100),
      a: 0.18 + Math.random() * 0.35,
      col: Math.random() < 0.5 ? rgb : '255, 255, 255',
    });
    const ps = Array.from({ length: 26 }, () => spawn(true));
    let last = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      ctx.clearRect(0, 0, W, H);
      ps.forEach((p, i) => {
        p.y -= p.v * dt;
        p.ph += dt * 0.8;
        const x = p.x + Math.sin(p.ph) * p.sway;
        const a = p.a * (0.6 + 0.4 * Math.sin(p.ph * 2.3));
        const g = ctx.createRadialGradient(x, p.y, 0, x, p.y, p.r * 3);
        g.addColorStop(0, `rgba(${p.col}, ${a})`);
        g.addColorStop(0.35, `rgba(${p.col}, ${a * 0.35})`);
        g.addColorStop(1, `rgba(${p.col}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, p.y, p.r * 3, 0, Math.PI * 2);
        ctx.fill();
        if (p.y < -20) ps[i] = spawn(false);
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [rgb]);
  return <canvas ref={ref} className="vn-tt-motes" aria-hidden="true" />;
}

/** 片头字幕逐字打出来 */
function useTyped(text: string, active: boolean, delay: number): string {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!active || !text) return;
    if (reduceMotion) {
      setN(text.length);
      return;
    }
    let i = 0;
    let tick = 0;
    const start = window.setTimeout(() => {
      tick = window.setInterval(() => {
        i++;
        setN(i);
        if (i >= text.length) window.clearInterval(tick);
      }, 55);
    }, delay);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(tick);
    };
  }, [text, active, delay]);
  return text.slice(0, n);
}

const Brand = () => (
  <span className="vn-tt-brand">
    <Feather size={16} />
    ANIMA
    <span className="vn-beta">BETA</span>
  </span>
);

export function VNTitle({
  variant,
  cardId,
  charName,
  tag,
  lastPlayed,
  lastLine,
  sprites,
  faces,
  spriteStage,
  spriteLayout,
  home,
  scenes,
  cards,
  onContinue,
  onNewStory,
  onSwitchCard,
  onLoad,
  onSettings,
  onExit,
}: Props) {
  const hasCard = Boolean(cardId);
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const root = useElementSize(rootRef);
  const box = useElementSize(boxRef);
  const portrait = root.w > 0 && root.w < root.h;

  const [mood, setMood] = useState<TitleMood>('idle');
  const hopRef = useRef<HTMLDivElement>(null);
  const moodTimer = useRef(0);
  const [leaving, setLeaving] = useState(false);
  const [picking, setPicking] = useState(false);

  // 换了角色:片头从头放、表情回到默认
  const [shot, setShot] = useState(0);
  const [shownCard, setShownCard] = useState(cardId);
  if (shownCard !== cardId) {
    setShownCard(cardId);
    setShot(0);
    setMood('idle');
    setPicking(false);
  }

  const idle = spriteForMood(sprites, 'idle');
  const accent = useLoaded(idle ? spriteImageUrl(idle) : null, accentOf) ?? DEFAULT_ACCENT;
  const paper: Paper | null = useLoaded(variant === 'poster' ? home.src : null, paperOf);

  // ---- 片头:上次的地方 → 场景包里的其他几个地方 → 回来 ----
  const shots = useMemo(
    () => [home, ...scenes.filter((s) => s.key !== home.key)].slice(0, MAX_SHOTS),
    [home, scenes],
  );
  const cinema = variant === 'cinema';
  useEffect(() => {
    if (!cinema || leaving || shots.length < 2 || reduceMotion) return;
    const t = window.setTimeout(() => setShot((s) => (s + 1) % shots.length), shot === 0 ? HOME_MS : SHOT_MS);
    return () => window.clearTimeout(t);
  }, [cinema, leaving, shot, shots.length]);
  const atHome = !cinema || shot === 0 || leaving;
  const montage = useMemo(() => montageSprites(sprites), [sprites]);

  // ---- 立绘:按场合挑表情,按脸摆 ----
  const pose = POSES[variant][portrait ? 'port' : 'land'];
  const expr =
    mood !== 'idle'
      ? spriteForMood(sprites, mood)
      : !atHome && montage.length > 0
        ? montage[(shot - 1) % montage.length]
        : idle;
  const layer: Layer | null = useMemo(() => {
    const src = expr ? spriteImageUrl(expr) : null;
    if (!expr || !src) return null;
    const face = faces.get(expr.id) ?? null;
    const style =
      leaving && cinema
        ? spriteStyle(face, spriteLayout, spriteStage)
        : titleSpriteStyle(face, expr.face_scan?.height ?? null, pose, box.h);
    return { key: expr.id, src, style };
  }, [expr, faces, leaving, cinema, spriteLayout, spriteStage, pose, box.h]);

  // 纸上印的那张脸(海报)
  const ghost = variant === 'poster' ? spriteForMood(sprites, 'ghost') : null;
  const ghostFace = ghost ? (faces.get(ghost.id) ?? null) : null;
  const ghostSrc = ghost ? spriteImageUrl(ghost) : null;

  const hover = (m: TitleMood) => () => {
    window.clearTimeout(moodTimer.current);
    setMood(m);
  };
  const unhover = () => {
    window.clearTimeout(moodTimer.current);
    moodTimer.current = window.setTimeout(() => setMood('idle'), 180);
  };
  const poke = () => {
    if (leaving) return;
    window.clearTimeout(moodTimer.current);
    setMood('poke');
    if (!reduceMotion) {
      hopRef.current?.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(-1.6%)', offset: 0.35 }, { transform: 'translateY(0)' }],
        { duration: 500, easing: 'cubic-bezier(.3, 1.6, .5, 1)' },
      );
    }
    moodTimer.current = window.setTimeout(() => setMood('idle'), 2200);
  };
  useEffect(() => () => window.clearTimeout(moodTimer.current), []);

  const cont = () => {
    if (leaving) return;
    window.clearTimeout(moodTimer.current);
    setMood('idle');
    setPicking(false);
    setShot(0);
    setLeaving(true);
    // 电影:先回到上次的地方、黑边收起、立绘挪到游戏里的位置,再淡出;海报直接淡出
    window.setTimeout(onContinue, reduceMotion ? 0 : cinema ? 1300 : 380);
  };
  const act: Record<TitleMood, () => void> = {
    continue: cont,
    new: onNewStory,
    load: onLoad,
    config: onSettings,
    exit: onExit,
    idle: () => {},
    poke,
    ghost: () => {},
  };
  const disabled = (m: TitleMood) => !hasCard && (m === 'continue' || m === 'load' || m === 'new');

  const menuButton = (m: (typeof MENU)[number], extra: ReactNode = null) => (
    <button
      key={m.mood}
      onClick={act[m.mood]}
      onPointerEnter={hover(m.mood)}
      onPointerLeave={unhover}
      onFocus={hover(m.mood)}
      onBlur={unhover}
      disabled={disabled(m.mood)}
    >
      <span className="zh">{m.zh}</span>
      {extra}
    </button>
  );
  const exitButton = (cls: string, label: string) => (
    <button className={cls} onClick={onExit} onPointerEnter={hover('exit')} onPointerLeave={unhover}>
      {label}
    </button>
  );

  const played = lastPlayed ? relTime(lastPlayed) : '';
  const castFaces = (
    <>
      {cards.map((c) => (
        <Face
          key={c.id}
          card={c}
          current={c.id === cardId}
          onPick={() => {
            setPicking(false);
            if (c.id !== cardId) onSwitchCard(c.id);
          }}
        />
      ))}
    </>
  );

  const vars = {
    '--tt-acc': accent.acc,
    '--tt-acc-deep': accent.deep,
    ...(paper ? { '--tt-paper': paper.paper, '--tt-ink': paper.ink } : {}),
  } as CSSProperties;

  const sprite = (
    <div ref={boxRef} className={`vn-tt-sprites${cinema ? ' game-box' : ''}`}>
      <div ref={hopRef} className="vn-tt-sprite-in">
        <SpriteStack layer={layer} onPoke={poke} />
      </div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`vn-title ${variant}${paper?.dark ? ' dark' : ''}${leaving ? ' leaving' : ''}${portrait ? ' portrait' : ''}`}
      style={vars}
    >
      {variant === 'poster' ? (
        <>
          <div className="vn-tt-photo">
            <img
              key={home.key}
              className="vn-tt-bg"
              src={home.src}
              style={{ objectPosition: `${home.focus}% 50%` }}
              alt=""
              draggable={false}
            />
          </div>
          <div className="vn-tt-panel">
            <img className="vn-tt-frost" src={home.src} alt="" draggable={false} />
            {ghost && ghostFace && ghostSrc && (
              <img
                key={ghost.id}
                className="vn-tt-ghost"
                src={ghostSrc}
                alt=""
                draggable={false}
                style={
                  {
                    height: `${(0.36 / ghostFace.h) * 100}cqh`,
                    transform: `translate(${-(ghostFace.x + ghostFace.w / 2) * 100}%, ${-(ghostFace.y + ghostFace.h / 2) * 100}%)`,
                    '--ghost-at': `${(ghostFace.x + ghostFace.w / 2) * 100}% ${(ghostFace.y + ghostFace.h / 2) * 100}%`,
                  } as CSSProperties
                }
              />
            )}
            <div className="vn-tt-grain" />
          </div>
          <div className="vn-tt-edge" />
          <div className="vn-tt-edge2" />
          {sprite}

          <nav className="vn-tt-cast" aria-label="角色">
            <span className="vn-tt-cast-label">角色</span>
            <div className="vn-tt-cast-list">{castFaces}</div>
          </nav>

          <div className="vn-tt-ui">
            <Brand />
            <div key={cardId ?? 'none'} className="vn-tt-hero">
              {hasCard ? (
                <>
                  {tag && <div className="vn-tt-tag">{tag}</div>}
                  <div className="vn-tt-name" style={{ '--len': [...charName].length } as CSSProperties}>
                    {charName}
                  </div>
                  {played && <div className="vn-tt-meta">上次 · {played}</div>}
                  {lastLine && <p className="vn-tt-quote">{lastLine}</p>}
                </>
              ) : (
                <>
                  <div className="vn-tt-tag">NEW STORY</div>
                  <div className="vn-tt-name" style={{ '--len': 4 } as CSSProperties}>
                    选一个角色
                  </div>
                  <div className="vn-tt-meta">
                    {cards.length > 0 ? '点头像,开始你们的故事' : '库里还没有角色卡,先回调试台导入一张'}
                  </div>
                </>
              )}
            </div>
            <nav className="vn-tt-menu">
              {MENU.map((m) => menuButton(m, <span className="en">{m.en}</span>))}
            </nav>
            {exitButton('vn-tt-exit', '回调试台 →')}
          </div>
        </>
      ) : (
        <>
          <div className="vn-tt-shots">
            {shots.map((s, i) => (
              <img
                key={s.key}
                className={`vn-tt-bg${i === (atHome ? 0 : shot) ? ' cur' : ''}`}
                src={s.src}
                style={{ objectPosition: `${s.focus}% 50%` }}
                alt=""
                draggable={false}
              />
            ))}
          </div>
          {sprite}
          <div className="vn-tt-grade" />
          <Motes rgb={accent.rgb} />

          <div className="vn-tt-bar top">
            <Brand />
            <span className="vn-tt-meta">
              {hasCard ? (
                <>
                  <b>{charName}</b>
                  {tag && `　${tag}`}
                  {played && `　·　${played}`}
                </>
              ) : (
                '还没有选角色'
              )}
            </span>
          </div>

          <div className={`vn-tt-loc${!atHome ? ' show' : ''}`}>
            <span>{shots[shot]?.label}</span>
          </div>

          {picking ? (
            <div className="vn-tt-pick">
              <div className="vn-tt-cast-list">{castFaces}</div>
            </div>
          ) : (
            <Subtitle
              who={hasCard ? charName : ''}
              line={hasCard ? lastLine : cards.length > 0 ? '选一个角色,开始你们的故事' : '库里还没有角色卡,先回调试台导入一张'}
              active={atHome && !leaving}
            />
          )}

          <div className="vn-tt-bar bottom">
            <nav className="vn-tt-menu">
              {MENU.map((m) => menuButton(m))}
              <button
                className={picking ? 'on' : ''}
                onClick={() => setPicking((p) => !p)}
                disabled={cards.length === 0}
                aria-expanded={picking}
              >
                <span className="zh">换角色</span>
              </button>
              {exitButton('minor', '回调试台')}
            </nav>
          </div>
        </>
      )}
    </div>
  );
}

function Subtitle({ who, line, active }: { who: string; line: string | null; active: boolean }) {
  const typed = useTyped(line ?? '', active, 1200);
  if (!line) return null;
  return (
    <div className={`vn-tt-sub${active ? '' : ' hide'}`}>
      {who && <div className="who">{who}</div>}
      <div className="line">
        {typed}
        {typed.length < line.length && active && <span className="caret" />}
      </div>
    </div>
  );
}
