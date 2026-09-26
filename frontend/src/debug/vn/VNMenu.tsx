/**
 * 局内全屏菜单:左边一列导航,右边换页。游戏画面还在后面,只是模糊压暗。
 * 竖屏时导航变成顶部一排能横着滑的标签(见 vn.css)。
 *
 * 这里只管壳子,每页画什么由外面传进来。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Feather } from './Feather';

export type MenuPage = 'log' | 'save' | 'card' | 'plugin' | 'preset' | 'model' | 'config' | 'dev';

const MENU_PAGES: { key: MenuPage; name: string }[] = [
  { key: 'log', name: '历史' },
  { key: 'save', name: '存档' },
  { key: 'card', name: '角色' },
  { key: 'plugin', name: '插件' },
  { key: 'preset', name: '预设' },
  { key: 'model', name: '模型' },
  { key: 'config', name: '设置' },
];

const PAGE_NAME: Record<MenuPage, string> = {
  log: '历史',
  save: '存档',
  card: '角色',
  plugin: '插件',
  preset: '预设',
  model: '模型',
  config: '设置',
  dev: '开发者',
};

interface Props {
  page: MenuPage;
  onPage: (page: MenuPage) => void;
  /** 导航顶上:角色名 + 当前对话名 */
  charName: string;
  chatName: string;
  /** 页头右侧的额外控件(比如历史页的「显示原文」) */
  headExtra?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  onTitle: () => void;
}

export function VNMenu({ page, onPage, charName, chatName, headExtra, children, onClose, onTitle }: Props) {
  // 窄屏时导航是一排横滑的标签,当前页可能在屏幕外 —— 换页时把它滚进来
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector('.vn-nav.on')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [page]);

  return (
    <div className="vn-menu" role="dialog" aria-label="菜单">
      <nav className="vn-menu-nav" ref={navRef}>
        <div className="vn-menu-brand">
          <Feather size={22} />
          <div>
            <strong>{charName || '还没选角色'}</strong>
            <span>{chatName}</span>
          </div>
        </div>
        {MENU_PAGES.map((p) => (
          <button
            key={p.key}
            className={`vn-nav${page === p.key ? ' on' : ''}`}
            aria-current={page === p.key ? 'page' : undefined}
            onClick={() => onPage(p.key)}
          >
            {p.name}
          </button>
        ))}
        <div className="vn-nav-gap" />
        <button
          className={`vn-nav minor${page === 'dev' ? ' on' : ''}`}
          onClick={() => onPage('dev')}
        >
          开发者
        </button>
        <button className="vn-nav minor" onClick={onTitle}>
          返回标题
        </button>
        <button className="vn-nav back" onClick={onClose}>
          返回游戏 <kbd>Esc</kbd>
        </button>
      </nav>

      <section className={`vn-menu-page page-${page}`}>
        <header className="vn-menu-head">
          <h2>{PAGE_NAME[page]}</h2>
          {headExtra}
        </header>
        <div className="vn-menu-body">{children}</div>
      </section>
    </div>
  );
}
