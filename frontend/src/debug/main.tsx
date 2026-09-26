import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DebugApp from './DebugApp';

// 手机上没法接 Mac 看 Safari 远程调试:加 ?debug=1 在页面里弹一个悬浮
// console 面板(eruda),报错和网络请求直接看得到。留着长期用,不用不加载。
if (new URLSearchParams(location.search).has('debug')) {
  import('eruda').then(({ default: eruda }) => eruda.init());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DebugApp />
  </StrictMode>,
);
