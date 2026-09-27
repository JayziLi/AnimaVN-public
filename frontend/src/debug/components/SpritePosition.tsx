/**
 * 立绘插件的「位置」一组:一块和游戏里一样的舞台,看立绘摆在哪、拖动微调。
 *
 * 所有角色都按脸对齐(plugins/spriteLayout.ts),这里调两样:
 *   这张卡:拖动挪位置、滑条放大缩小、关掉自动对齐
 *   所有角色共用的构图:人物大小(镜头远近)、头的高度
 * 可以把另一个角色半透明地叠上来对照,看两人是不是一样大、一样高。
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  debugApi,
  sceneFileUrl,
  spriteImageUrl,
  type CardSprite,
  type SceneAsset,
  type SpriteLayout,
} from '../lib/api';
import { enabledOnly } from '../plugins/common';
import { backgroundsOf } from '../plugins/scene';
import {
  FACE_SIZE_RANGE,
  FACE_TOP_RANGE,
  ZOOM_RANGE,
  facesByCanvas,
  spriteStyle,
  type FaceBox,
} from '../plugins/spriteLayout';
import type { SpriteLayoutState } from '../plugins/useSpriteLayout';

type Mode = 'wide' | 'tall';

/** 和 vn.css 的 --vn-sprite-top 一致:舞台从屏幕多高的地方开始 */
const STAGE_TOP: Record<Mode, number> = { wide: 0.07, tall: 0.11 };
/** 对话框(连同下面的输入框)大概盖住屏幕底部多少,只是给个参照 */
const BOX_HEIGHT: Record<Mode, number> = { wide: 0.31, tall: 0.27 };
const FALLBACK_BG = '/vn/bg/uni.jpg';
/** 和后端 SpriteLayoutUpdate 的范围一致 */
const OFFSET_MAX = 2;

const round = (v: number) => Math.round(v * 1000) / 1000;
const clampOffset = (v: number) => round(Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, v)));
const pct = (v: number) => `${Math.round(v * 100)}%`;

interface Reference {
  cardId: string;
  sprite: CardSprite;
  face: FaceBox | null;
  layout: SpriteLayout;
}

/** 对照的那个角色:它的默认立绘(排最前、没禁用、有图的那张)和它自己的摆法 */
function useReference(cardId: string): Reference | null {
  const [ref, setRef] = useState<Reference | null>(null);
  useEffect(() => {
    if (!cardId) return;
    let alive = true;
    Promise.all([debugApi.listSprites(cardId), debugApi.getSpriteLayout(cardId)])
      .then(([list, layout]) => {
        const usable = enabledOnly(list).filter((s) => s.has_image);
        const first = usable[0];
        if (!alive) return;
        setRef(
          first
            ? { cardId, sprite: first, face: facesByCanvas(usable).get(first.id) ?? null, layout }
            : null,
        );
      })
      .catch(() => {
        if (alive) setRef(null);
      });
    return () => {
      alive = false;
    };
  }, [cardId]);
  return ref && ref.cardId === cardId ? ref : null;
}

export function SpritePosition({
  card,
  sprites,
  sceneAssets,
  cards,
  state,
}: {
  card: { id: string; name: string };
  /** 这张卡的全部立绘;禁用的、没图的不参与 */
  sprites: CardSprite[];
  /** 这张卡绑的场景包里的素材,拿默认背景当预览底图 */
  sceneAssets: SceneAsset[];
  /** 可以拿来对照的角色 */
  cards: { id: string; name: string }[];
  state: SpriteLayoutState;
}) {
  const { stage, layout, changeLayout, changeStage } = state;
  // 和游戏里一样只看没禁用的,算出来的脸框才一致
  const usable = useMemo(() => enabledOnly(sprites).filter((s) => s.has_image), [sprites]);
  const faces = useMemo(() => facesByCanvas(usable), [usable]);
  const [pickId, setPickId] = useState<string | null>(null);
  const sprite = usable.find((s) => s.id === pickId) ?? usable[0] ?? null;
  const face = sprite ? (faces.get(sprite.id) ?? null) : null;
  const [mode, setMode] = useState<Mode>('wide');
  const [refId, setRefId] = useState('');
  const ref = useReference(refId);

  const bg = enabledOnly(backgroundsOf(sceneAssets)).find((a) => a.has_file) ?? null;
  const bgUrl = (bg && sceneFileUrl(bg)) ?? FALLBACK_BG;

  const found = usable.filter((s) => faces.has(s.id)).length;
  const unscanned = usable.filter((s) => s.face_scan === null).length;

  // ---- 在舞台上拖动 = 挪这张卡的位置;挪的量按舞台高度折算 ----
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; h: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const h = box.current?.clientHeight;
    if (!h || !sprite) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, dx: layout.dx, dy: layout.dy, h };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    changeLayout({
      dx: clampOffset(d.dx + (e.clientX - d.x) / d.h),
      dy: clampOffset(d.dy + (e.clientY - d.y) / d.h),
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  if (usable.length === 0) {
    return <div className="sp-empty">这张卡还没有能用的立绘(有图、没禁用),先在下面加表情。</div>;
  }

  const others = cards.filter((c) => c.id !== card.id);

  return (
    <div className="spp">
      <div className="spp-row">
        <div className="spp-seg">
          {(['wide', 'tall'] as const).map((m) => (
            <button
              key={m}
              className={`btn small${mode === m ? ' accent' : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'wide' ? '电脑横屏' : '手机竖屏'}
            </button>
          ))}
        </div>
        <label className="spp-ref">
          <span className="conn-label">对照</span>
          <select className="text-input" value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">不对照</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || '(未命名)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className={`spp-stage ${mode}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        title="拖动立绘挪位置"
      >
        <img
          className="spp-bg"
          src={bgUrl}
          alt=""
          draggable={false}
          style={{ objectPosition: `${bg?.focus_x ?? 50}% 50%` }}
        />
        <div className="spp-sprites" ref={box} style={{ top: pct(STAGE_TOP[mode]) }}>
          {sprite && (
            <img
              className="spp-sprite"
              src={spriteImageUrl(sprite) ?? ''}
              alt={sprite.label}
              draggable={false}
              style={spriteStyle(face, layout, stage)}
            />
          )}
          {ref && (
            <img
              className="spp-sprite ghost"
              src={spriteImageUrl(ref.sprite) ?? ''}
              alt=""
              draggable={false}
              style={spriteStyle(ref.face, ref.layout, stage)}
            />
          )}
          {/* 所有角色的脸的上沿都对到这条线(再加上各自的微调) */}
          <div className="spp-guide" style={{ top: `${stage.faceTop * 100}cqh` }} />
        </div>
        <div className="spp-box" style={{ height: pct(BOX_HEIGHT[mode]) }}>
          对话框
        </div>
      </div>

      <div className="spp-chips">
        {usable.map((s) => (
          <button
            key={s.id}
            className={`spp-chip${s.id === sprite?.id ? ' on' : ''}${faces.has(s.id) ? '' : ' noface'}`}
            onClick={() => setPickId(s.id)}
            title={faces.has(s.id) ? undefined : '没找到脸,按撑满高度摆'}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="sp-group-note">
        {state.scanning
          ? '正在找脸…'
          : state.scanError
            ? `找不了脸:${state.scanError}`
            : unscanned > 0
              ? `还有 ${unscanned} 张没找过脸`
              : found === usable.length
                ? `${usable.length} 张都按脸对齐(同样大的图共用一个脸的位置,换表情时人不会动)。在画面上拖动立绘可以挪位置。`
                : `${usable.length} 张里 ${found} 张按脸对齐;找不到脸的(标灰)按撑满高度摆。在画面上拖动立绘可以挪位置。`}
      </div>

      <div className="spp-controls">
        <div className="spp-head">这个角色 · {card.name || '(未命名)'}</div>
        <label className="spp-check">
          <input
            type="checkbox"
            checked={layout.auto}
            onChange={(e) => changeLayout({ auto: e.target.checked })}
          />
          按脸自动对齐
          <span className="sp-group-note">(认错脸的时候关掉,改成撑满高度、居中)</span>
        </label>
        <Slider
          label="放大缩小"
          min={ZOOM_RANGE.min}
          max={ZOOM_RANGE.max}
          step={0.01}
          value={layout.zoom}
          shown={`×${layout.zoom.toFixed(2)}`}
          onChange={(zoom) => changeLayout({ zoom })}
        />
        <div className="spp-row">
          <span className="sp-group-note">
            位置:左右 {Math.round(layout.dx * 100)},上下 {Math.round(layout.dy * 100)}(拖动画面调)
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="btn small"
            onClick={() => changeLayout({ zoom: 1, dx: 0, dy: 0 })}
            disabled={layout.zoom === 1 && layout.dx === 0 && layout.dy === 0}
          >
            重置
          </button>
          <button
            className="btn small"
            disabled={state.scanning}
            onClick={() => void state.rescan()}
            title="整套立绘重新找一遍脸"
          >
            重新识别脸
          </button>
        </div>

        <div className="spp-head">所有角色</div>
        <Slider
          label="人物大小"
          min={FACE_SIZE_RANGE.min}
          max={FACE_SIZE_RANGE.max}
          step={0.005}
          value={stage.faceSize}
          shown={`脸占 ${pct(stage.faceSize)}`}
          onChange={(faceSize) => changeStage({ ...stage, faceSize })}
        />
        <Slider
          label="头的高度"
          min={FACE_TOP_RANGE.min}
          max={FACE_TOP_RANGE.max}
          step={0.005}
          value={stage.faceTop}
          shown={`离顶 ${pct(stage.faceTop)}`}
          onChange={(faceTop) => changeStage({ ...stage, faceTop })}
        />
      </div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  shown,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  shown: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="spp-slider">
      <span className="conn-label">{label}</span>
      <input
        className="sp-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="sp-slider-value">{shown}</span>
    </label>
  );
}
