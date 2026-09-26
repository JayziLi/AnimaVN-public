import type { DebugPersona } from './api';

/** 没设头像时的兜底(frontend/public/assets),酒馆那边同样是给个灰人占位 */
export const DEFAULT_AVATAR = '/assets/default-avatar.jpg';

export const avatarOf = (p: DebugPersona | null | undefined) => p?.avatar || DEFAULT_AVATAR;
