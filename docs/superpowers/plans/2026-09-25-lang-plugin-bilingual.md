# 外语插件(日语配音 + 中文字幕)实施计划

**执行结果(2026-09-25):** Task 1–5、7 做完;Task 6 只导入了未花、知更鸟(诺亚由另一个会话导入);台式机蓝屏写坏了 GSV 的配置,台式机会话修好后,两个声音经后端实测都能合成。代码没按计划里的 commit 步骤提交:视觉小说和插件的代码整体都还不在仓库里,单独提交这几个文件编译不过。和设计的出入写在设计文档开头。

> **For agentic workers:** 按任务顺序做,每步用复选框(`- [ ]`)跟踪。设计见 `docs/superpowers/specs/2026-09-25-lang-plugin-bilingual-design.md`。

**Goal:** 主模型按「一行日语、下一行中文」写回复;视觉小说里日语小字在上、中文在下,Wikira 的台词用日语声音念;并准备好日语预设、日语 Wikira 卡和三个日语声音。

**Architecture:** 新增纯函数模块 `plugins/lang.ts`:认日语行、摘掉日语后交给原来的 `parseReply`、把日语挂回句子上、按声音语言决定念什么。视觉小说里原来调 `parseReply` 的三处换成 `parseBilingual`;`planVoiceLines` 改用 `speechText` 取文字。插件界面放新文件 `LangPanel.tsx`,由插件抽屉挂进去。内容和声音走现有的后端接口。

**Tech Stack:** React 19 + TypeScript(Vite),FastAPI 后端(不改代码),台式机上的 GPT-SoVITS。

## Global Constraints

- 输出格式:每段先一行日语,紧接着下一行是它的中文;不加标签。认日语靠假名(不含「・」)。
- 插件配置键 `plugin.lang`,字段 `blockPrompt`、`showJa`(默认 true);插件块 identifier `anima_lang`,名字「外语指令 · 插件」。
- 念哪种语言看声音的 `text_lang`:`ja` / `all_ja` 念日语,缺日语不念;其他念中文,只有日语的句子不念。
- 后端不改代码;数据只新增,不改现有的预设、卡、声音。
- 另一个会话已经改完 `VNScreen.tsx`、`PluginsDrawer.tsx`、`DebugApp.tsx`、`plugins/voice.ts`(末尾追加了参数定义)、`vn.css`(`.vn-plugin-embed` 一段):动之前重新读,不碰它改的部分。
- 提交信息不加 Co-Authored-By。前端没有测试框架:纯函数用 `tsc --noCheck` 编到临时目录、node 跑校验脚本;整体靠 `npm run build`、`npm run lint`、浏览器实测。
- 浏览器实测前备份 `plugin.*` 设置,不点「恢复默认」。

---

### Task 1: `plugins/lang.ts` 纯函数 + `VNLine` 新字段

**Files:**
- Create: `frontend/src/debug/plugins/lang.ts`
- Modify: `frontend/src/debug/vn/script.ts`(`VNLine`)
- Modify: `frontend/src/debug/plugins/common.ts`(`PLUGIN_BLOCK_IDS`)
- Check(临时,不进仓库): 草稿目录里的 `lang-check.ts`

**Interfaces:**
- Produces:
  - `LANG_SETTING_KEY = 'plugin.lang'`、`LANG_BLOCK_ID = 'anima_lang'`、`DEFAULT_LANG_BLOCK_PROMPT: string`
  - `interface LangPluginConfig { blockPrompt: string; showJa: boolean }`、`DEFAULT_LANG_CONFIG`、`normalizeLangConfig(raw: unknown): LangPluginConfig`
  - `langBlockState(preset, order): BlockState`、`insertLangBlock(preset, groupIndex, content): TavernPreset`
  - `hasKana(text: string): boolean`、`isJaLang(lang: string): boolean`
  - `parseBilingual(raw: string, opts: { charName: string; tags: readonly TagKind[]; streaming: boolean }): ParsedReply`
  - `speechText(line: VNLine, voiceLang: string): string | null`
  - `VNLine` 新增可选字段 `ja?: string`、`jaOnly?: boolean`

- [ ] **Step 1: 写校验脚本(先失败)**

草稿目录 `lang-check.ts`(import 用 lang.ts 的绝对路径):

```ts
import { hasKana, isJaLang, parseBilingual, speechText } from '/path/to/AnimaVN/frontend/src/debug/plugins/lang';
import { vnTagKinds } from '/path/to/AnimaVN/frontend/src/debug/vn/tags';

const kinds = vnTagKinds('<sprite:{表情}>', '<bg:{场景}>', '<bgm:{音乐}>');
const opts = { charName: 'Wikira', tags: kinds, streaming: false };
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
};

eq('假名', [hasKana('おかえり'), hasKana('欢迎回来'), hasKana('阮・梅'), hasKana('エルジェイ')], [true, false, false, true]);
eq('语言', [isJaLang('ja'), isJaLang('all_ja'), isJaLang('zh'), isJaLang('JA')], [true, true, false, true]);

const raw1 = [
  '<sprite:坏笑>',
  '「エルジェイ様、さっきのドヤ顔、ぜんぜん隠せてなかったよ？」',
  '「Lj sama 刚才那副得意的样子，一点都没藏住哦？」',
  '',
  '彼女はくすっと笑った。',
  '她轻笑一声。',
].join('\n');
const p1 = parseBilingual(raw1, opts);
eq('交替:句子', p1.lines, [
  { speaker: 'Wikira', text: '「Lj sama 刚才那副得意的样子，一点都没藏住哦？」', ja: '「エルジェイ様、さっきのドヤ顔、ぜんぜん隠せてなかったよ？」' },
  { speaker: null, text: '她轻笑一声。', ja: '彼女はくすっと笑った。' },
]);
eq('交替:标签落在中文句上', p1.hits.map((h) => [h.label, h.lineIndex]), [['坏笑', 0]]);
eq('交替:句尾在原文里', p1.ends.map((e) => raw1.slice(0, e).split('\n').pop()), ['「Lj sama 刚才那副得意的样子，一点都没藏住哦？」', '她轻笑一声。']);

const raw2 = '<sprite:微笑>「おかえり！」\n「你回来啦！」';
eq('日语行开头的标签留给中文', parseBilingual(raw2, opts).hits.map((h) => [h.label, h.lineIndex]), [['微笑', 0]]);

const raw3 = '「……」\n「……」\n她没说话。';
eq('没有假名的日语行不认(整条没有假名)', parseBilingual(raw3, opts).lines.length, 3);
const raw4 = 'ふふ。\n呵呵。\n「……」\n「……」';
eq('一字不差的两行:前一行是日语', parseBilingual(raw4, opts).lines.map((l) => [l.text, l.ja ?? null]), [['呵呵。', 'ふふ。'], ['「……」', '「……」']]);

const raw5 = 'おやすみ。\nまた明日。\n晚安。';
eq('日语后面还是日语:前一行当正文', parseBilingual(raw5, opts).lines.map((l) => [l.text, l.ja ?? null, l.jaOnly ?? false]), [['おやすみ。', null, true], ['晚安。', 'また明日。', false]]);

const raw6 = '「おかえり」\n「你回来啦」\n\n彼女は笑っ';
const p6 = parseBilingual(raw6, { ...opts, streaming: true });
eq('流式:正在写的日语先占一句', p6.lines.map((l) => [l.text, l.ja ?? null]), [['「你回来啦」', '「おかえり」'], ['', '彼女は笑っ']]);

eq('没有日语:和原来一样', parseBilingual('「你好」\n她笑了。', opts).lines, [{ speaker: 'Wikira', text: '「你好」' }, { speaker: null, text: '她笑了。' }]);

const jaLine = { speaker: 'Wikira', text: '「你回来啦」', ja: '「おかえり」' };
const zhLine = { speaker: 'Wikira', text: '「你回来啦」' };
const jaOnly = { speaker: 'Wikira', text: '「おかえり」', jaOnly: true };
eq('念什么', [speechText(jaLine, 'ja'), speechText(zhLine, 'ja'), speechText(jaOnly, 'ja'), speechText(jaLine, 'zh'), speechText(jaOnly, 'zh')], ['「おかえり」', null, '「おかえり」', '「你回来啦」', null]);

console.log(fail ? `${fail} 项失败` : '全部通过');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: 跑,确认失败**

```bash
cd frontend && npx tsc --noCheck --module commonjs --moduleResolution node10 --target es2022 --outDir <草稿>/langcheck <草稿>/lang-check.ts && node <草稿>/langcheck/<编出来的 lang-check.js>
```
Expected: 编译失败,找不到 `plugins/lang`。

- [ ] **Step 3: 实现**

`vn/script.ts` 的 `VNLine`:

```ts
export interface VNLine {
  /** 说话人;旁白是 null */
  speaker: string | null;
  text: string;
  /** 外语插件:这句上面那行日语(配音用,小字显示);没有就不带这个字段 */
  ja?: string;
  /** 外语插件:这句本身就是日语(模型只写了日语、没写中文) */
  jaOnly?: boolean;
}
```

`plugins/common.ts`:`PLUGIN_BLOCK_IDS = ['anima_sprite', 'anima_bg', 'anima_bgm', 'anima_lang'] as const;`

`plugins/lang.ts`:见实现提交(常量、配置、块、`hasKana`、`isJaLang`、`splitRows`、`parseBilingual`、`speechText`)。要点:
- 按 `\n` 分行,每行 `extractTags`(流式时只对最后一行用 streaming)摘标签得到内容;用 `indexOf` 顺序找回每个标签在原文里的位置
- 行分三类:空(含只有标签的行)、日语(有假名)、正文;整条有日语时,再把「下一行非空内容和它一字不差」的正文行改判为日语
- 日语行的去向:下一非空行是正文 → 挂上去;后面没有非空行且在流式 → 正在写(追加 `text: ''` 的句子);否则 → 当正文留着(`jaOnly`)
- 摘掉的日语行只留下它里面的标签原文,换行保留;逐字记 reduced → 原文下标
- `parseReply(reduced)`;每句按 `ends` 落在哪行找来源行;同一行的第一句挂日语;`ends` 换回原文:`e === 0 ? 0 : map[e - 1] + 1`

- [ ] **Step 4: 跑校验,全部通过**

同 Step 2 的命令。Expected: `全部通过`。

- [ ] **Step 5: `npm run build` 和 `npm run lint` 通过后提交**

```bash
git add frontend/src/debug/plugins/lang.ts
git commit -m "feat(lang): parse Japanese-then-Chinese replies" -- frontend/src/debug/plugins/lang.ts frontend/src/debug/vn/script.ts frontend/src/debug/plugins/common.ts
```

### Task 2: 语音按声音语言取文字

**Files:**
- Modify: `frontend/src/debug/plugins/voice.ts`(`planVoiceLines`,不碰文件末尾另一个会话追加的部分)

**Interfaces:**
- Consumes: `speechText(line, voiceLang)`(Task 1)

- [ ] **Step 1:** `planVoiceLines` 里:

```ts
    const said = speechText(ln, profile.text_lang);
    if (said === null) return null;
    const text = cleanSpeech(said);
    if (!hasSpeakable(text)) return null;
```
替换原来的 `const text = cleanSpeech(ln.text);`,文件头 import `speechText`。

- [ ] **Step 2:** 校验脚本加一条:日语声音的主声音计划里,有 `ja` 的句子请求文字是日语、没有的是 null(构造最小的 `VoiceCast` 和 `EmotionContext`:`resolve` 一律返回 `{ state: 'exact', label }`)。跑通。

- [ ] **Step 3:** build + lint,提交 `feat(lang): voice speaks the Japanese line when the voice is Japanese`。

### Task 3: 视觉小说接上双语(解析、对话框、历史、存档缩略图)

**Files:**
- Modify: `frontend/src/debug/vn/VNScreen.tsx`(解析缓存、插话截断、对话框、历史;新 prop `showJa`)
- Modify: `frontend/src/debug/vn/VNSaves.tsx`(缩略图取句子)
- Modify: `frontend/src/debug/vn/vn.css`(新 class `.vn-ja`、`.vn-log-ja`)

- [ ] **Step 1:** `VNScreen.tsx`:`parseReply` 的两处调用(条目解析缓存、插话截断)换成 `parseBilingual`,参数不变;`Props` 加 `showJa: boolean`。
- [ ] **Step 2:** 对话框:`{body !== null && …vn-text…}` 前面加

```tsx
{showJa && current?.ja && !waiting && <div className="vn-ja">{current.ja}</div>}
```
- [ ] **Step 3:** 历史 `lineView`:`vn-log-text` 里最前面加 `{showJa && ln.ja && <span className="vn-log-ja">{ln.ja}</span>}`。
- [ ] **Step 4:** 控制台里这句语音的说明:主声音是日语、这句是 Wikira 的台词但没有日语时写「缺日语,没念」(找到控制台显示「主声音「…」」的那一段,按同样的写法加)。
- [ ] **Step 5:** `VNSaves.tsx` 的 `parseReply` 换成 `parseBilingual`。
- [ ] **Step 6:** `vn.css`(放在 `.vn-text.narration` 后面;历史的放在 `.vn-log-speaker` 后面):

```css
/* 外语插件:中文上方的日语,小一号、淡一点 */
.vn-ja {
  font-size: calc(clamp(16px, 0.9vw + 10px, 21px) * var(--vn-text-scale) * 0.72);
  line-height: 1.5;
  color: var(--vn-text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  margin-bottom: -4px;
}
.vn-log-ja {
  display: block;
  font-size: 0.8em;
  color: var(--vn-text-dim);
}
```
- [ ] **Step 7:** build + lint,提交 `feat(vn): show Japanese above Chinese and parse bilingual replies`。

### Task 4: 插件界面和配置

**Files:**
- Create: `frontend/src/debug/components/LangPanel.tsx`
- Modify: `frontend/src/debug/components/PluginsDrawer.tsx`(`PluginKey` 加 `'lang'`、左栏加「外语」、`Props.lang`、渲染 `LangPanel`)
- Modify: `frontend/src/debug/DebugApp.tsx`(`langConfig` 状态、读写 `plugin.lang`、`pluginTemplates`、`pluginOfBlock`、`insertPluginBlock` / `blockControls` 认 `'lang'`、`renderPluginsDrawer` 传 `lang`、`VNScreen` 传 `showJa`)

**Interfaces:**
- `LangPanel({ config, onChangeConfig, blockGroup }: { config: LangPluginConfig; onChangeConfig: (next: LangPluginConfig) => void; blockGroup: ReactNode })`
- `PluginsDrawer` 的 `Props.lang: { config: LangPluginConfig; onChangeConfig: (next: LangPluginConfig) => void; block: BlockControls }`

- [ ] **Step 1:** `LangPanel.tsx`:四组 —— 说明(做什么 + 格式示例 `<pre className="pl-preview">`)、`blockGroup`(抽屉传进来的 `BlockGroup`)、提示词模板(`id="pl-prompt-lang"`,textarea + 「恢复默认模板」)、显示(复选框「视觉小说里在中文上方显示日语」)。样式全用抽屉现有的 class(`sp-group`、`sp-group-head`、`sp-group-title`、`sp-group-note`、`text-input pl-wide pl-textarea`、`pl-row`、`btn small`)。
- [ ] **Step 2:** `PluginsDrawer.tsx`:`PluginKey = 'sprite' | 'bg' | 'bgm' | 'lang'`;`PLUGINS` 在语音后面加 `{ key: 'lang', name: '外语', ready: true }`;`sp-body` 里 `{section === 'lang' && <LangPanel … blockGroup={<BlockGroup what="外语" block={props.lang.block} … />} />}`。
- [ ] **Step 3:** `DebugApp.tsx`:照 `spriteConfig` 的写法加 `langConfig` / `changeLangConfig`(改内存,停手半秒写 `plugin.lang`),开机 `getSetting(LANG_SETTING_KEY)`;`pluginTemplates` 加 `[LANG_BLOCK_ID]: langConfig.blockPrompt`;`pluginOfBlock` 认 `LANG_BLOCK_ID` → `'lang'`;`insertPluginBlock` / `blockControls` 的 kind 加 `'lang'`(`insertLangBlock` / `langBlockState`);`renderPluginsDrawer` 传 `lang={{ config: langConfig, onChangeConfig: changeLangConfig, block: blockControls('lang') }}`;`<VNScreen showJa={langConfig.showJa} …>`。
- [ ] **Step 4:** build + lint,提交 `feat(lang): lang plugin page and config`。

### Task 5: 日语预设和日语 Wikira 卡

后端 `http://127.0.0.1:8000`,脚本放草稿目录。

- [ ] **Step 1: 预设** —— `POST /api/tavern/presets/d583f6574dd34676a9ddb0fbd5a2b447/duplicate {"name": "Wikira DeepSeek - galgame 日语"}`;取回后在 `prompts` 里加 `{"identifier": "anima_lang", "name": "外语指令 · 插件", "role": "system", "content": <DEFAULT_LANG_BLOCK_PROMPT>, "marker": false, "system_prompt": false, "injection_position": 0, "injection_depth": 4, "forbid_overrides": false}`,每个含 `anima_bgm` 的编排组里在它后面插 `{"identifier": "anima_lang", "enabled": true}`;`PUT` 回去。核对:原预设没变,新预设里外语块开着、「▪ 日&汉 双语输出」关着。
- [ ] **Step 2: 卡** —— `POST /api/tavern/cards/981e412c1629424b8c1de7b8f15db628/duplicate {"name": "Wikira"}`;`PUT` 新卡:`tags` 加「日语配音」,`character_version` = 「日语配音版」,`description` 末尾追加「日语设定」一段,`first_mes`、`mes_example` 换成日中交替版(原中文逐段保留,每段前补一行日语)。核对:新卡带着 17 张立绘和场景包,原卡没变。

### Task 6: 三个日语声音

- [ ] **Step 1: 挑参考** —— 按 Wikira 的 17 个表情,每个声音各挑一段 3–10 秒(尽量 4–9.5 秒)的原声;未花、诺亚从 `downloads\ba_ja\` 的 wiki 原声里挑,知更鸟从 `downloads\ds_ja_robin\` 里挑(先按中文索引挑,再按文件名对到日语)。找不到的表情作为别名挂到最接近那条上。
- [ ] **Step 2: 台式机** —— 模型挪到 `models\<名字>_ja\`,参考拷到 `refs\<名字>_ja\【情绪】原文.wav`(文件名不合法的字符替换掉,原文以 refs.json 为准),写 `refs.json`(`character`、`gpt_weights`、`sovits_weights`、`refs: [{file, emotion, text}]`,「微笑」排第一)。
- [ ] **Step 3: 导入** —— `POST /api/voices/import`(`connection_id` = 5090 那个连接),再 `PUT` 档案把 `text_lang` 改成 `ja`,把近似的表情名加进对应情绪行的别名。每个声音预热一次,抽几种情绪试合成。
- [ ] **Step 4: 绑定** —— `PUT /api/tavern/cards/<日语卡 id>/voices {"main": <未花(日语) 的 id>, "extras": []}`。
- [ ] **Step 5:** `docs/voice-server.md` 记下三个声音的位置、每个表情用的原声、哪些是近似。

### Task 7: 浏览器实测和收尾

- [ ] 备份 `plugin.*` 设置;打开视觉小说,选日语卡 + 新预设,用真实模型发一条
- [ ] 核对:日语小字先出、中文跟着出;Wikira 台词念日语、情绪跟立绘;缺日语不念且控制台有记录;关掉「显示日语」只剩中文;历史回看、插话截断正常;窄屏不溢出;菜单里换成诺亚 / 知更鸟也能念;旧 Wikira 卡和旧聊天不受影响
- [ ] 设计文档状态改成「已实现」,写上和设计的出入;测试对话问用户要不要删
