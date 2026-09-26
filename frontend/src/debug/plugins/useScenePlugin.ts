/**
 * 背景 / BGM 插件在调试台里的全部状态:两份全局配置、场景包列表、
 * 当前这张卡绑的包,以及包里的素材。
 *
 * 配置和立绘一样:先改内存,停手半秒再写库。素材跟着「当前卡绑的包」走,
 * 换卡时重新拉;切得快时旧请求可能后到,只收当前这张卡的结果。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { debugApi, type SceneAsset, type ScenePack } from '../lib/api';
import type { PluginConfig } from './common';
import { SCENE, normalizeSceneConfig, type SceneKindKey } from './scene';

type Notify = (kind: 'ok' | 'error', message: string) => void;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ScenePluginState {
  configs: Record<SceneKindKey, PluginConfig>;
  changeConfig: (kind: SceneKindKey, next: PluginConfig) => void;
  packs: ScenePack[];
  refreshPacks: () => Promise<void>;
  /** 当前卡绑的场景包;没选卡或没绑时为 null */
  packId: string | null;
  /** 当前卡绑的包里的素材 */
  assets: SceneAsset[];
  /** 改当前卡的绑定(null = 解绑) */
  bindPack: (packId: string | null) => Promise<void>;
  /** 抽屉里改完素材后把新列表交回来;不是当前包的结果丢掉 */
  changeAssets: (packId: string, next: SceneAsset[]) => void;
  /** 包被删了:如果正绑着它,本地也解绑 */
  forgetPack: (packId: string) => void;
}

export function useScenePlugin(cardId: string | null, notify: Notify): ScenePluginState {
  const [configs, setConfigs] = useState<Record<SceneKindKey, PluginConfig>>({
    bg: SCENE.bg.defaults,
    bgm: SCENE.bgm.defaults,
  });
  const saveTimers = useRef<Partial<Record<SceneKindKey, number>>>({});

  const changeConfig = (kind: SceneKindKey, next: PluginConfig) => {
    setConfigs((c) => ({ ...c, [kind]: next }));
    window.clearTimeout(saveTimers.current[kind]);
    saveTimers.current[kind] = window.setTimeout(() => {
      debugApi
        .putSetting(SCENE[kind].settingKey, next)
        .catch((e: unknown) => notify('error', `插件配置保存失败: ${errText(e)}`));
    }, 500);
  };

  // 开机读一次配置。StrictMode 双跑也没关系:两次读到的是同一份
  useEffect(() => {
    for (const kind of ['bg', 'bgm'] as const) {
      debugApi
        .getSetting(SCENE[kind].settingKey)
        .then((v) => {
          if (v !== null) setConfigs((c) => ({ ...c, [kind]: normalizeSceneConfig(kind, v) }));
        })
        .catch((e: unknown) => notify('error', `插件配置读取失败: ${errText(e)}`));
    }
    const timers = saveTimers.current;
    return () => {
      window.clearTimeout(timers.bg);
      window.clearTimeout(timers.bgm);
    };
  }, [notify]);

  const [packs, setPacks] = useState<ScenePack[]>([]);
  const refreshPacks = useCallback(async () => {
    try {
      setPacks(await debugApi.listScenePacks());
    } catch (e) {
      notify('error', `场景包列表读取失败: ${errText(e)}`);
    }
  }, [notify]);

  const [packId, setPackId] = useState<string | null>(null);
  const [assets, setAssets] = useState<SceneAsset[]>([]);
  const cardRef = useRef<string | null>(null);
  const packRef = useRef<string | null>(null);

  const loadAssets = useCallback(
    async (forCard: string | null, pid: string | null) => {
      packRef.current = pid;
      setPackId(pid);
      setAssets([]);
      if (!pid) return;
      try {
        const list = await debugApi.listSceneAssets(pid);
        if (cardRef.current === forCard && packRef.current === pid) setAssets(list);
      } catch (e) {
        notify('error', `场景素材读取失败: ${errText(e)}`);
      }
    },
    [notify],
  );

  useEffect(() => {
    cardRef.current = cardId;
    packRef.current = null;
    setPackId(null);
    setAssets([]);
    if (!cardId) return;
    debugApi
      .getCardScenePack(cardId)
      .then((pid) => {
        if (cardRef.current === cardId) void loadAssets(cardId, pid);
      })
      .catch((e: unknown) => notify('error', `场景包绑定读取失败: ${errText(e)}`));
  }, [cardId, loadAssets, notify]);

  const bindPack = async (pid: string | null) => {
    if (!cardId) return;
    try {
      await debugApi.setCardScenePack(cardId, pid);
      await loadAssets(cardId, pid);
    } catch (e) {
      notify('error', `绑定场景包失败: ${errText(e)}`);
    }
    await refreshPacks();
  };

  const changeAssets = (pid: string, next: SceneAsset[]) => {
    if (packRef.current === pid) setAssets(next);
  };

  const forgetPack = (pid: string) => {
    if (packRef.current === pid) {
      packRef.current = null;
      setPackId(null);
      setAssets([]);
    }
  };

  return {
    configs,
    changeConfig,
    packs,
    refreshPacks,
    packId,
    assets,
    bindPack,
    changeAssets,
    forgetPack,
  };
}
