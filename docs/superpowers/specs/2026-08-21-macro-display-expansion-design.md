# 聊天区展开 {{user}} / {{char}} —— 设计

日期:2026-08-21
状态:已实现

## 问题

宏一直是「只在一条路上生效」。

组装提示词那条路全程都过了 `substituteMacros`:预设块、卡片描述、人设、
示例对话、连同对话历史每一条(`assembler.ts` 的 `chatHistory` 分支)。
发出去的提示词里 `{{user}}` 一直是对的。

但**聊天区直接渲染 `ChatEntry` 的原始文本**,中间没有任何宏处理。源头是
`chatEntry.ts` 的 `makeGreetingEntry` —— 把 `card.first_mes` 原样塞进
`swipes`,开场白里的 `{{user}}` 就这么字面显示出来。

历史列表的预览行(`ChatHistoryOverlay` 的 `last_message`)同一个毛病。

## 酒馆怎么做的

它是「烘焙派」,而且只烘焙第一条:

| 位置 | 做的事 |
|---|---|
| `script.js:1758-1765` | `messageFormatting` 里,只有 `messageId === 0` 且非用户/系统消息才替换,替换完写回 `chat[0].mes` |
| `script.js:4431` | 每次 Generate 前 `chat[0].mes = substituteParams(chat[0].mes)`,注释说是为了「reacts to user/character settings changes」 |
| `script.js:8114-8115` | 编辑消息时替换并写回 `mes.mes` |
| 模型输出 | 不碰 |

这套有个明显的毛病:**烘焙不可逆**。开场白第一次渲染就被替换成「小明」写回
存档,之后把玩家名字改成「小红」,那条里已经没有宏可替换了,4431 行那句
「reacts to settings changes」实际上只对还没渲染过的开场白成立。

## 我们的做法:渲染期替换,一个字都不写回

存库的永远是原文,只在画成气泡的那一刻替换。

1. **换人设立刻全局生效** —— 切玩家人设,历史里的开场白当场跟着变
2. **导出不失真** —— jsonl 里还是宏,回酒馆、换卡都对
3. **零迁移** —— 库里已有的数据不用动

代价是编辑那一栏要小心:**点编辑时输入框给的必须是原文**,否则一保存就等于
意外烘焙。`MessageRow` 里 `text` 是原文(编辑、保存、导出都走它),`shown`
是展开后的(只喂给 `renderQuoted`)。

### 覆盖范围

所有消息都展开 —— 开场白、用户输入、模型输出一视同仁。宏是产品语法不是模型
语法,模型偶尔吐一个 `{{user}}` 出来,展开比留着字面更接近玩家将来看到的东西。
(酒馆只处理 `chat[0]`,这一点我们和它不同。)

思维链(`.reasoning-body`)不展开 —— 和引号高亮的取舍一致,它是调试输出,
视觉和语义上都该次于正文。

### 随机类宏必须定种子

聊天区是每次 React 重渲染都跑一遍替换的。不定种子的话,你在输入框里敲个字,
上面开场白里的骰子就换个点数。

`substituteMacros(text, ctx, { seed })`:

- **传 seed** = 确定性。种子是 `${entry.id}:${entry.swipeIndex}`,再拼上宏在
  文中的**位置**和原文,所以同一行里的两个 `{{roll:d6}}` 是两个独立的骰子,
  而同一条消息刷新多少次都是同一组点数。实现是 FNV-1a 拌 mulberry32。
- **不传 seed** = 真随机。组装提示词走这条 —— 每次发送本来就该重掷。

思路照搬酒馆的 `{{pick}}`(`macros.js:516`,`chatIdHash + contentHash + offset`)。

时间类宏(`{{time}}` / `{{date}}`)不做种子,展开成当前时间就行,它不会跳。

## 改动

| 文件 | 改动 |
|---|---|
| `lib/macros.ts` | 新增 `buildMacroContext()`(组装和显示共用,免得两边算出不同的 `{{user}}`)、`MacroOptions.seed`、`seededRandom()`;`substituteMacros` 多一个 opts 参数 |
| `lib/assembler.ts` | 内联的 ctx 构造换成 `buildMacroContext()`,行为不变 |
| `components/ChatPanel.tsx` | 新增 `macros` prop;`shown = substituteMacros(text, macros, { seed })`,`renderQuoted(shown, quotes)`;`text` 原文留给编辑框 |
| `components/ChatHistoryOverlay.tsx` | 预览行过 `previewOf()`。取值来自**这一行自己**的 `card_name` / `user_name`,不是当前打开的卡 —— 列表里混着孤儿对话和分叉,拿当前卡的名字去套会张冠李戴 |
| `DebugApp.tsx` | `displayMacros` memo,喂给 ChatPanel |

## 不做的事

- **不动卡片编辑器** —— 右栏「开场白」那个框是编辑源文本的地方,显示原文才对
  (酒馆同理)。要预览效果去聊天区看
- **不补新宏** —— `{{pick}}` `{{input}}` `{{messageCount}}` `{{isodate}}`
  `{{trim}}` `{{// 注释}}` 这些酒馆常用的还没有,等要用时再说
- **不做宏自动补全** —— 酒馆在编辑框里敲 `{{` 会弹菜单,是个好功能,但和这次
  的 bug 无关

## 验证

- `lib/macros.ts` 单独编译后跑了 9 组断言:基本替换 / 大小写不敏感 / 嵌套一层 /
  未知宏原样保留 / 同种子 200 次结果一致 / 换种子有分布 / 同行两个骰子独立 /
  不给种子是真随机 / 空卡不炸
- 浏览器端(库用的是拷贝,没碰真库):把一条消息改成
  `{{char}} 对 {{user}} 说:「你好，{{user}}。」 骰子 {{roll:d20}} 与 {{roll:d20}} · 未知宏 {{nonsense}}`
  - 渲染成 `Anima 对 Lj 说:「你好，Lj。」 骰子 18 与 15 · 未知宏 {{nonsense}}`
  - 重新打开编辑框拿到的是原文,一字不差
  - 敲字触发重渲染、刷新页面,点数都还是 18/15
  - 库里 `debug_chat_messages.swipes` 仍含 `{{user}}` —— 确认没有被烘焙
  - 历史列表预览行:后端返回的 `last_message` 里带 `{{user}}`,界面上显示的是 `Lj`
- 拦截真实发出去的 POST(`/stream` 与 `/complete` 在到达 LLM 前被拦下):
  输入 `我是 {{user}}，你是 {{char}}。请重复我的名字。`,请求体里最后一条
  user 消息是 `我是 Lj，你是 Anima。请重复我的名字。`,11 条消息无一字面宏

## 宏设置(同日追加)

设置抽屉多了第二个分类「宏」,三段:

### 内置宏表

`BUILTIN_MACROS` 是**唯一事实来源** —— `macros.ts` 的解析器从它生成,这张表
也从它渲染,「实现了哪些宏」和「文档说有哪些宏」不可能再漂移。每行显示语法、
说明、别名,以及**当前这一刻的实际取值**(`{{char}}` → `Anima`,`{{persona}}`
为空就标「(空)」)。点宏名复制到剪贴板。

`{{random}}` / `{{roll}}` 这类每次求值都变的标「每次求值都不同」而不是取值 ——
在表格里掷一次骰子没有任何意义。

### 自定义宏

`{{名字}}` → 任意文本,值里可以再套宏(嵌套一层,比如值写 `{{char}} 温柔地说`)。
解析顺序在 `resolveOne`:内置 → 随机/时间 → **自定义** → 查无此宏就原样保留。
所以自定义宏**盖不掉内置** —— 起名叫 `char` 会被表单拦下
(`RESERVED_MACRO_NAMES`),就算绕过去解析时也轮不到它。

校验:名字为空 / 含大括号冒号空格 / 占用内置名(含别名)/ 和同门重名,行内
红字即时提示,非法行不进查找表(`toLookup` 只收 `isUsable` 的)。

底部「试一试」:左边随便写,右边实时展开,改卡、改人设、改自定义宏都即时反映。

### 存储:刻意不进 `debug.chatSettings`

自定义宏存独立的 `debug.customMacros`。原因:聊天设置(排版、字号、头像)是
纯显示偏好,「恢复默认」可以无脑重置;自定义宏**会进提示词**,跟着一起被清掉
就是事故。恢复按钮因此改成**按分类生效** —— 聊天页是「恢复默认」,宏页是
「清空自定义宏」,各管各的,换页时解除待确认状态。

### 改动

| 文件 | 改动 |
|---|---|
| `lib/customMacros.ts`(新) | 模型 + 校验 + localStorage 读写 |
| `lib/macros.ts` | `MacroContext.custom`、`BUILTIN_MACROS` / `MacroInfo` / `RESERVED_MACRO_NAMES`、解析顺序加自定义兜底 |
| `components/SettingsDrawer.tsx` | 分类导航 + `MacroSection`;恢复按钮按分类生效 |
| `DebugApp.tsx` | `customMacros` state、`macroLookup` memo;`assemble()` 两个调用点都传 `customMacros` —— 自定义宏不只用于显示,**也进发给模型的提示词** |
| `debug.css` | `.sp-macro-*` / `.sp-custom-*` / `.sp-try-*` |

### 验证(浏览器端,库仍是拷贝)

- 表内 `{{char}}` → `Anima`、`{{user}}` → `Lj`,共 14 行
- 加 `greeting_style` = `{{char}} 温柔地说`,试一试输入
  `{{greeting_style}}:「你好，{{user}}」` 展开为 `Anima 温柔地说:「你好，Lj」`
  (自定义宏的值里再套内置宏,嵌套一层生效)
- 起名 `char` 报「被内置宏占了」,起名 `bad:name` 报非法字符
- localStorage 落盘正确;发送 `{{greeting_style}} —— 对吧，{{user}}？`,
  拦截到的请求体里是 `Anima 温柔地说 —— 对吧，Lj？`
