/**
 * 立绘摆法在调试台里的状态:所有角色共用的构图、当前这张卡的微调,以及给还没找过脸的
 * 立绘补识别(老立绘、或者上传时服务器还没装 OpenCV)。怎么摆见 spriteLayout.ts。
 *
 * 和别的插件配置一样先改内存,停手一会儿再写库;拖动时每一下都改内存,只存最后一下。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { debugApi, type CardSprite, type SpriteLayout } from '../lib/api';
import {
  DEFAULT_SPRITE_LAYOUT,
  DEFAULT_SPRITE_STAGE,
  SPRITE_STAGE_KEY,
  normalizeSpriteStage,
  type SpriteStage,
} from './spriteLayout';

type Notify = (kind: 'ok' | 'error', message: string) => void;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SpriteLayoutState {
  stage: SpriteStage;
  changeStage: (next: SpriteStage) => void;
  /** 当前卡的微调;没选卡时是默认值 */
  layout: SpriteLayout;
  changeLayout: (patch: Partial<SpriteLayout>) => void;
  /** 整套重新找一遍脸 */
  rescan: () => Promise<void>;
  scanning: boolean;
  /** 找不了脸的原因(比如服务器没装 OpenCV) */
  scanError: string | null;
}

export function useSpriteLayout(
  cardId: string | null,
  sprites: readonly CardSprite[],
  onSpritesChange: (cardId: string, next: CardSprite[]) => void,
  notify: Notify,
): SpriteLayoutState {
  // ---- 全局构图 ----
  const [stage, setStage] = useState<SpriteStage>(DEFAULT_SPRITE_STAGE);
  const stageTimer = useRef<number | undefined>(undefined);
  const changeStage = (next: SpriteStage) => {
    setStage(next);
    window.clearTimeout(stageTimer.current);
    stageTimer.current = window.setTimeout(() => {
      debugApi
        .putSetting(SPRITE_STAGE_KEY, next)
        .catch((e: unknown) => notify('error', `立绘构图保存失败: ${errText(e)}`));
    }, 500);
  };
  useEffect(() => {
    debugApi
      .getSetting(SPRITE_STAGE_KEY)
      .then((v) => {
        if (v !== null) setStage(normalizeSpriteStage(v));
      })
      .catch((e: unknown) => notify('error', `立绘构图读取失败: ${errText(e)}`));
    return () => window.clearTimeout(stageTimer.current);
  }, [notify]);

  // ---- 当前卡的微调 ----
  const [layout, setLayout] = useState<SpriteLayout>(DEFAULT_SPRITE_LAYOUT);
  const latest = useRef<SpriteLayout>(DEFAULT_SPRITE_LAYOUT);
  /** 还没写库的那一下;换卡时立刻写掉,不然停手之前换卡就丢了 */
  const pending = useRef<{ cardId: string; layout: SpriteLayout; timer: number } | null>(null);
  const cardRef = useRef<string | null>(null);

  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    window.clearTimeout(p.timer);
    debugApi
      .putSpriteLayout(p.cardId, p.layout)
      .catch((e: unknown) => notify('error', `立绘位置保存失败: ${errText(e)}`));
  }, [notify]);

  useEffect(() => {
    flush();
    cardRef.current = cardId;
    latest.current = DEFAULT_SPRITE_LAYOUT;
    setLayout(DEFAULT_SPRITE_LAYOUT);
    if (!cardId) return;
    debugApi
      .getSpriteLayout(cardId)
      .then((l) => {
        if (cardRef.current !== cardId) return;
        latest.current = l;
        setLayout(l);
      })
      .catch((e: unknown) => notify('error', `立绘位置读取失败: ${errText(e)}`));
  }, [cardId, flush, notify]);
  useEffect(() => flush, [flush]);

  const changeLayout = (patch: Partial<SpriteLayout>) => {
    if (!cardId) return;
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setLayout(next);
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = { cardId, layout: next, timer: window.setTimeout(flush, 400) };
  };

  // ---- 补识别 ----
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const tried = useRef(new Set<string>());
  const spritesChange = useRef(onSpritesChange);
  useEffect(() => {
    spritesChange.current = onSpritesChange;
  });

  const runScan = useCallback(async (forCard: string, rescan: boolean) => {
    setScanning(true);
    try {
      spritesChange.current(forCard, await debugApi.scanSpriteFaces(forCard, rescan));
      setScanError(null);
    } catch (e) {
      setScanError(errText(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => setScanError(null), [cardId]);

  // 每张卡最多自动补一次:服务器找不了脸的话,不要每次刷新列表都再问
  useEffect(() => {
    if (!cardId || tried.current.has(cardId)) return;
    const missing = sprites.some((s) => s.card_id === cardId && s.has_image && s.face_scan === null);
    if (!missing) return;
    tried.current.add(cardId);
    void runScan(cardId, false);
  }, [cardId, sprites, runScan]);

  const rescan = () => (cardId ? runScan(cardId, true) : Promise.resolve());

  return { stage, changeStage, layout, changeLayout, rescan, scanning, scanError };
}
