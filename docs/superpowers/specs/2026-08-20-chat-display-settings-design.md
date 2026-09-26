# 聊天区显示设置 —— 设计

日期:2026-08-20
状态:已确认,待实现

## 要解决的问题

调试台的聊天区一直是写死的一套样式:13px 字、一种排版、纯灰阶无高亮。
长对话读起来累,而且不同人的偏好差别很大(有人要密、有人要松,有人喜欢
IM 那种对向气泡、有人只想读一整篇文字)。

三件事:

1. 角色说的话(`""` `「」` 这类引号里的内容)要和叙述文字区分开
2. 字号可调
3. 排版给几套方案让用户自己选,不由我们替他定

## 总体形态:一个可扩展的「设置」抽屉

顶栏新增一颗 `设置` 按钮,和现有的 `API 设置` / `玩家` 并列。点开后的呈现
方式与那两个抽屉完全一致 —— 绝对定位盖在 `.chat-col` 顶部,复用
`.conn-drawer` 那套外壳类,不遮左右两栏。

抽屉内部是「左侧分类导航 + 右侧设置项」。现在只有「聊天」一类,以后所有
新增的显示/行为设置都往这里塞,不再往顶栏加按钮。

三个抽屉(设置 / API / 玩家)互斥:打开任一个自动收起另外两个 —— 它们
占的是同一块屏幕区域,同时开会互相盖住。

### 持久化

纯前端显示偏好,不进数据库,存 localStorage,写法沿用 `lib/budget.ts`:
新建 `lib/chatSettings.ts`,导出 `loadChatSettings()` / `saveChatSettings()`
和 `DEFAULT_CHAT_SETTINGS`。单个键 `debug.chatSettings` 存一个 JSON 对象,
逐字段做合法性校验后与默认值合并 —— 以后加字段时老数据不会炸。

```ts
interface ChatSettings {
  layout: 'bubble' | 'duo' | 'document' | 'compact' | 'script';
  fontScale: number;        // 0.75 ~ 1.6,步长 0.05
  lineHeight: number;       // 1.5 | 1.7 | 1.9
  chatWidth: number;        // 640 | 760 | 960 | 0(满宽)
  avatarSize: number;       // 24 ~ 72 px,步长 4
  avatarShape: 'rounded' | 'square' | 'circle';
  highlightQuotes: boolean;
  quoteColor: string;       // 预设色板里的一个
}
```

## 一、引号高亮

新建 `lib/richText.tsx`,把一段正文切成 `ReactNode[]`,引号(连同引号本身)
包一层 `<span class="chat-quote">`。

正则照搬酒馆 `script.js:1846` 那条的引号部分,覆盖六种:

| 符号 | 码点 |
|---|---|
| `" "` | `U+0022` |
| `“ ”` | `U+201C` / `U+201D` |
| `「 」` | `U+300C` / `U+300D` |
| `『 』` | `U+300E` / `U+300F` |
| `« »` | `U+00AB` / `U+00BB` |
| `＂ ＂` | `U+FF02` |

**不**照搬酒馆的代码块/HTML 转义分支 —— 我们这边正文是纯文本渲染
(`white-space: pre-wrap`),没有 markdown 也没有 HTML,那些分支没有意义。

`.` 默认不匹配换行,所以引号不跨行 —— 和酒馆一致。这条很重要:落单的一个
`"` 不会把后面整篇都染色。

流式输出时,还没闭合的引号保持原样,闭合的那一刻才染色。这是正则的天然
行为,不需要额外处理。

样式**只改文字颜色**,不动字重、不加背景。

`debug.css` 开头明确写了这套主题「不用色相,靠明度拉开层级」,唯一的例外是
`--danger`。引号色是第二个例外,理由同样成立:靠明度区分不出「谁在说话」,
必须用色相。新增 `--quote` 变量,由 JS 写内联值覆盖,色板给五个:

| 名字 | 值 |
|---|---|
| 暖黄(默认) | `#d8a657` |
| 青 | `#7fbfbf` |
| 玫红 | `#e08aa0` |
| 淡紫 | `#b3a0e0` |
| 中性亮 | `#ffffff` |

只作用在消息正文上。思维链(`.reasoning-body`)保持纯文本 —— 它是调试输出,
视觉上应当次于正文。

## 二、字号、列宽与头像

### 先说一个改过的决定

第一版的字号只作用在 `.chat-text` 和 `.composer-input` 上,理由是「别把整套
UI 撑变形」。实测下来这是错的:正文放大之后头像、昵称还钉在原地,整块的
比例失衡,叙述文字反而显得比原来更小。

业内的两条路都不是这么做的:

- **Discord** 拆成两条独立旋钮 —— `Chat Font Scaling`(12~24px,只动消息
  正文)和 `Zoom Level`(50%~200%,连头像、间距一起放大)
- **酒馆** 只有一条 `Font Scale`(0.5~1.5),但它挂在 `body` 上
  (`--mainFontSize: calc(var(--fontScale) * 15px)`),所有按 em 排的东西
  一起变;头像大小另外由 `Avatars` 选形状、`Chat Width` 管列宽

我们取两者的交集:**字号一条(管整块消息的文字)+ 头像一条(管脸)**。

### 字号

`.panel.chat` 上挂 `--chat-scale`(0.75~1.6,上下限对齐酒馆的 0.5~1.5 和
Discord 的 12~24px)。下面几处的 `font-size` 都写成 `calc(基准 * var(--chat-scale))`:

| 选择器 | 基准 |
|---|---|
| `.chat-text` | 13px |
| `.chat-who`(昵称) | 12px |
| `.chat-meta`(模型/耗时) | 10px |
| `.reasoning-body`(思维链) | 12px |
| `.composer-input` | 13px |

各排版方案里改过昵称字号的(document 11px / compact 11px / script 10px)
同样带上倍率,相对关系保持不变。

左右两栏、顶栏、按钮不参与 —— 这是「聊天区」的设置,不是全局缩放。

### 消息列宽度

原来三处写死 760px(`.chat-msg` / `.chat-error` / `.composer-inner`)改成
`var(--chat-width)`,四档:窄 640 / 标准 760 / 宽 960 / 满宽。对应酒馆的
`Chat Width`(它是占屏宽的百分比,这里给固定档更好挑)。

满宽档存的值是 `0`,写进 CSS 时转成 `100%` 而不是 `none` —— `duo` 排版的
气泡上限是 `calc(var(--chat-width) * 0.74)`,`none` 会让这个 calc 失效。

### 头像

`--avatar-size`(24~72px,默认 36)和 `--avatar-radius`(圆角 5px / 方 0 /
圆 50%)。和字号分开是刻意的,对齐 Discord 那两条旋钮的分法。

`compact` 排版原来写死 24px,改成 `calc(var(--avatar-size) * 0.7)` ——
把头像调大之后紧凑排版也该跟着大,只是仍比别的排版小一圈。

设置里给一张示范头像即时反映大小和形状,放在一个 76px 的固定格子里,
拖滑块时右边的控件不会跟着左右晃。

## 三、排版 5 套方案

全部由 `.panel.chat` 上的 `data-layout` 驱动 CSS,`ChatPanel.tsx` 的消息
渲染逻辑一行不改。

| key | 名字 | 效果 |
|---|---|---|
| `bubble` | 气泡 | 现状:头像在左,正文一个带边框的块 |
| `duo` | 对向 | 用户消息整体靠右、角色靠左,气泡宽度贴合内容,IM 感 |
| `document` | 文档 | 去掉头像与所有框线,靠留白 + 一条极淡的分隔线断句,长文连读 |
| `compact` | 紧凑 | 头像缩到 24px、内外边距收紧,一屏能塞下更多条 |
| `script` | 剧本 | 无头像;名字是 mono 大写拉开字距的名牌;正文左缩进并挂一道竖线 |

行距另开一档三选一(紧凑 1.5 / 标准 1.7 / 宽松 1.9),写成 `--chat-line`
作用在 `.chat-text` 上 —— 和排版方案正交,任意组合。字号、列宽、头像
同理:五套排版乘以这几条,任何组合都不该出错。

`duo` 需要动 flex 方向,这是唯一一个要处理 `.chat-msg-head` 内
`.chat-msg-actions` 那个 `margin-left: auto` 的方案(反向后要改成
`margin-right: auto`)。

## 数据流

```
DebugApp
  ├ state: chatSettings, drawer('settings'|'api'|'persona'|null)
  ├ <SettingsDrawer settings onChange onClose />   // 改一次写一次 localStorage
  └ <ChatPanel settings ... />
        └ .panel.chat  data-layout={layout}
                       style={{ '--chat-scale', '--chat-line', '--chat-width',
                                '--avatar-size', '--avatar-radius', '--quote' }}
              └ .chat-text  →  renderQuoted(text, highlightQuotes)
```

`SettingsDrawer` 是纯受控组件:自己不存状态,改动直接回调给 `DebugApp`,
由它统一 setState + 落盘。这样将来加分类时不会各存各的。

## 不做的事

- 不做自定义主题色/背景图 —— 那是另一个量级的功能
- 不做 markdown 渲染 —— 调试台要看的是模型原样吐出来的字
- 不做每角色/每对话独立设置 —— 这是「我的眼睛怎么舒服」,全局一份就够
