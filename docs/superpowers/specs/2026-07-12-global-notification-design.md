# 全局顶部通知系统

## 背景

目前"报错/结果提示"这件事在项目里有好几套互不相干的实现：`GameScreen` 用 `ErrorToast`(右上角固定条,手动关闭,不自动消失)显示发消息失败;`CharacterEditModal`、`SaveLoadModal` 各自维护一个 `error` state,渲染在表单底部的 `.modal-error` 小字里;`CharacterHome` 有自己的 `.charhome-error`/`.select-hint`;`ConnectionsPanel`(刚做完的重设计)有 `.conn-banner`,固定在弹窗内部顶部、3.6 秒自动消失。用户看过 `ConnectionsPanel` 的效果后,要求把这个"顶部横幅+自动消失"的体验推广成全应用统一的一套,参照 SillyTavern 顶部弹出的绿色 toast,并且要保留手动关闭(右侧一个叉)。

## 设计

### 架构

`App.tsx` 成为唯一持有通知状态的地方:

```ts
type Notification = { kind: "ok" | "error"; message: string } | null;
const [notification, setNotification] = useState<Notification>(null);
const notifyTimer = useRef<number | undefined>(undefined);

const notify = useCallback((kind: "ok" | "error", message: string) => {
  window.clearTimeout(notifyTimer.current);
  setNotification({ kind, message });
  notifyTimer.current = window.setTimeout(() => setNotification(null), 3600);
}, []);

const dismissNotification = useCallback(() => {
  window.clearTimeout(notifyTimer.current);
  setNotification(null);
}, []);
```

新建 `frontend/src/components/GlobalNotice.tsx`:接收 `notification`/`onDismiss`,`notification` 为 `null` 时不渲染任何东西;否则渲染一条 `position: fixed` 固定在浏览器视口最顶部(`top:0; left:0; right:0`)、z-index 高于 `.modal-overlay`(120)的横幅,盖在包括弹窗遮罩在内的所有内容之上,左侧文字、右侧一个 `✕` 按钮(点击调用 `onDismiss`),同时 3.6 秒后自动消失(计时器逻辑在 `App.tsx` 的 `notify` 里,组件本身不需要自己计时)。视觉复用 `ConnectionsPanel` 已经做好的滑入动画(`connBannerIn` keyframe 沿用,改个更通用的名字)和 ok/error 两种配色。

`App.tsx` 渲染 `<GlobalNotice notification={notification} onDismiss={dismissNotification} />`,放在 `.app-shell` 内、所有其他内容之后(保证 DOM 顺序不影响,因为它是 `position:fixed`)。

### 谁改成调用 notify

`notify: (kind: "ok" | "error", message: string) => void` 作为新 prop,自 `App.tsx` 依次往下传给:

- `CharacterSelect` → 再往下传给 `CharacterEditModal`(`CharacterEditModal` 现在自己的 `error` state 只用来展示,改成直接调用 `props.notify("error", ...)`,不再需要本地 `error` state 和 `.modal-error` 渲染;校验类错误,如"角色名称不能为空",同样走 `notify("error", ...)`)
- `CharacterHome`(现有的 `error`/`hint` state 和 `.charhome-error`/`.select-hint` 渲染全部去掉,`handleContinue`/`handleNewGame` 的 catch 分支和"已开始新游戏"提示都改成调用 `notify(...)`。附带一个简化:`handleNewGame` 里原来为了让用户在组件卸载前看到提示、特意 `await new Promise(resolve => setTimeout(resolve, 1400))` 卡住跳转的逻辑可以删掉了——通知现在是 `App` 级别的全局状态,不会因为 `CharacterHome` 卸载、切到 `GameScreen` 就跟着消失,`notify` 调用完直接 `onStart(...)` 即可,提示会带着自己的 3.6 秒计时器跨屏幕继续显示。)
- `GameScreen`(不再渲染 `<ErrorToast>`;改成一个 `useEffect` 监听 `engine.error`,非空时调用 `notify("error", engine.error)` 然后立即 `engine.clearError()`——展示和计时的职责整体转移给全局通知,`useDialogueEngine` 自己的 `error` state 不需要再对外持久展示)
- `ConnectionsPanel`(把刚做的本地 `banner` state + `showBanner` 辅助函数整个删掉,`.conn-banner` 相关调用全部改成 `props.notify(...)`)
- `SaveLoadModal`(和 `CharacterEditModal` 一样,本地 `error` state 只用于展示,改成直接调用 `props.notify("error", ...)`)

`CharacterSelect` 里给"PNG 角色卡导入尚未支持"用的 `showHint`/`.select-hint` **不在这次改动范围内**——那是一个"功能还没做"的提示,不是某次操作成功/失败的结果,ok/error 两态硬套上去不合适,继续保持组件本地状态、局部展示。

### 清理

- `frontend/src/components/ErrorToast.tsx` 整个删除,`GameScreen.tsx` 里对它的引用一并删掉。
- `App.css` 里的 `.error-toast`、`.error-toast-message`、`.error-toast-close`、`.error-toast-close:hover` 一并删除(不会再被引用)。
- `App.css` 里 `.conn-banner`、`.conn-banner.ok`、`.conn-banner.error` 连同 `connBannerIn` keyframe 一起改名/挪到一个新的、更通用的位置(比如 `.global-notice`/`.global-notice.ok`/`.global-notice.error`),不再局限于"connections panel"这个语境。
- 上一轮改动给 `.modal-body` 加的 `position: relative` 这次一并撤掉——那是专门为"横幅贴在弹窗内部顶部"这个(现在已经不用的)方案加的,全局通知走 `position:fixed` 之后完全用不上了。
- `frontend/src/types.ts`/`frontend/src/api/client.ts` 本次不需要改动。

### 范围边界

- 不做通知队列/多条堆叠——同一时刻只有一条通知,新的直接顶替旧的(和已经验证过的 `ConnectionsPanel` 版本行为一致)。
- 不影响 `CharacterSelect` 的 PNG 导入提示(见上)。
- 不改动后端;这是纯前端的状态/组件重构。
