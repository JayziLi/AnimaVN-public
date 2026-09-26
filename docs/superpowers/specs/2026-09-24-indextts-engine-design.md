# 语音 · 接入 IndexTTS-2.5 —— 设计

状态:**AnimaVN 这边已实现(2026-09-24,未提交)**,用假服务测过;等台式机的小服务联调。实现和本文的出入见实施计划 `docs/superpowers/plans/2026-09-24-indextts-engine.md` 开头的表。台式机那边已经部署好(9890),第一轮试听用户觉得明显不如 GSV(零样本克隆 vs 阿米娅专属微调;22.05 kHz vs 48 kHz),第二轮(长参考、fp32、扩散 50 步)在做。听完之前先不配 IndexTTS 的声音,代码留着。
日期:2026-09-24
前置:语音功能的设计见 `2026-09-24-vn-voice-design.md`;5090 的环境、实测数据见 `docs/voice-server.md`

## 背景

- 用户反馈语音「完全没有情绪变化」。原因是 GSV 的语气照搬参考音频,而每个声音只有一段「平静」参考。要补情绪参考,就得找干员原声,可干员语音大多比较温和,慌张、生气、害羞这类强烈情绪的片段很少
- GSV 每句约 1.7 秒:声学部分每一步都在固定 1000 帧上跑 DiT,GPU 已经占满,换设置、多开实例都没用
- IndexTTS-2.5(bilibili,2026-08-10 发布,约 0.8B 参数)把音色和情绪分开控制:音色用一段参考音频;情绪可以用 8 维向量,也可以用另一段音频(可以是别人的声音)。声学部分从 DiT 换成了 Zipformer,技术报告说比 2.0 快 2.28 倍(A10 上 RTF 0.136)
- LingChat(用户参考的另一个项目)接了 11 种引擎,但真正把情绪传给引擎的只有 IndexTTS2 和 Fish S2。它的 IndexTTS2 做法是「情绪标签查表得到向量,强度 0.6」

## 已确认的决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 和 GSV 的关系 | 两个都留。IndexTTS 是第二个引擎,每个声音选一个语音服务(也就是选一个引擎) | 同一个角色可以建两个声音,在卡上切主声音就能对比 |
| 2 | 服务端 | 台式机上跑我们自己写的 FastAPI 小服务,包一层 `IndexTTS2`,端口 9890,先只监听 127.0.0.1 | 官方只有 Gradio 网页界面,没有 HTTP 接口;生产部署推荐的 vLLM 不支持 Windows |
| 3 | 情绪控制 | **向量为主,参考音频可选**:情绪行填了参考音频就用参考,否则用向量,都没有就不控制 | 向量不用找素材、可控、每次结果一样;有合适的片段时参考音频更自然。官方的情绪评测测的都是参考音频这种用法 |
| 4 | 情绪参考从哪来 | 可以是别的角色的声音 | IndexTTS 把音色和情绪分开处理,这样缺原声也有办法 |
| 5 | 情绪强度 | 语音服务上的一个选项 `emo_alpha`,**默认 1.0**(一开始定的 0.6,2026-09-25 用户试听后改) | 起初参考官方建议(文本情绪模式 0.6 左右)、社区经验(参考音频 0.6–0.8)和 LingChat(0.6);实测服务端会先把向量归一化(合计压到 0.8 以内),0.6 听着偏弱,用户觉得强度高的好 |
| 6 | 不做「读台词自己判断」 | 不用 `use_emo_text` | 不跟立绘走,和画面上的表情可能对不上;官方也承认容易演过头 |
| 7 | 默认向量 | 内置一张「表情名 → 向量」表,可以一键给这张卡的立绘表情生成情绪行,之后边听边改 | 数值没有标准答案,要靠试听调;先给一套能用的起点 |
| 8 | 开工顺序 | 两边同时开工,AnimaVN 这边先用假服务开发 | 用户要求。试听不满意的话,AnimaVN 这边的改动也不白做:引擎接口本来就是为多引擎准备的 |

## 小服务接口(两边的约定)

由台式机的「Index-tts 部署」会话来写和维护,代码在台式机 `D:\AnimaVoice\indextts-server\`(部署说明是同目录下的 `DEPLOY.md`),用 `D:\IndexTTS` 的 uv 环境来跑。AnimaVN 只依赖下面这些接口。

`GET /health` → 200 `{"model": "IndexTTS-2.5", "ready": true}`;模型还在加载时 `ready` 为 false。

`POST /tts`,JSON:

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | str | 必填,去掉空白后不能为空 |
| `lang` | str | `zh` / `en` / `ja` / `es` / `ar`,默认 `zh`,服务端转成大写 |
| `spk_audio_path` | str | 必填,音色参考,台式机本地绝对路径 |
| `emo_audio_path` | str \| null | 情绪参考 |
| `emo_vector` | float[8] \| null | 顺序 [高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静];每个数 0–1.2,加起来不超过 1.5 |
| `emo_alpha` | float | 0–1,默认 0.6。两种模式下意思一样:生效的情绪 = 强度 × 情绪 |
| `duration_factor` | float | 0.5–2.0,默认 1.0,大于 1 念得更慢 |

- `emo_audio_path` 和 `emo_vector` 最多给一个;两个都不给就沿用音色参考自带的语气
- 成功返回 200,`audio/wav`,响应头 `X-Elapsed-Ms`
- 参数问题返回 400,推理报错返回 500,body 都是 `{"detail": "<原因>"}`;路径不存在时,报错里带上路径
- 服务端同一时刻只推理一个请求;`use_random` 固定为 False

## 结构

后端(`AnimaBackend/`):
- `app/tts/base.py` —— `VoiceSpec` 加两个字段 `spk_ref_path`、`emo_vector`,两个都有默认值,GSV 不用。`TTSEngine` 协议加一个 `check(voice, label)`:这个引擎缺哪项必填配置,就抛 `TTSError(400, ...)`
- `app/tts/indextts.py`(新)—— `IndexTtsEngine`:锁、冷启动 90 秒 / 正常 30 秒两档超时、报错映射、`/health` 做连接测试
- `app/tts/gpt_sovits.py` —— 把 `_voice_for` 里现在那几条 GSV 专用的检查挪进 `check()`,文案不变
- `app/tts/emotion_presets.py`(新)—— 默认向量表,以及「立绘表情 → 向量」的查法
- `app/tts/registry.py` —— 加 `indextts` 分支;签名里加上 `emo_alpha`
- `app/api/tts.py` —— 连接的增删改查支持 `api_type` 和 `emo_alpha`;`_voice_for` 按引擎组装 `VoiceSpec`;合成响应加 `X-TTS-Emo-Mode`
- `app/api/voices.py` —— 声音加「音色参考」;情绪行加向量;refs.json 多两个可选字段;新接口「按立绘表情补齐情绪行」
- `app/models.py`、`app/schemas.py`、`app/main.py`(CORS 的 `expose_headers` 加 `X-TTS-Emo-Mode`)
- `scripts/migrate_voice_indextts_columns.py`(新)—— 给已有的库加列

前端(`frontend/src/debug/`):
- `lib/api.ts` —— 类型和方法跟着后端改;`speak()` 多读一个 `X-TTS-Emo-Mode`
- `components/VoicePanel.tsx` —— 连接能选引擎;IndexTTS 的声音填音色参考,情绪表填向量和情绪参考;「按立绘表情补齐」按钮
- `components/EmotionVectorEditor.tsx`(新)—— 8 个数值的编辑器。`VoicePanel.tsx` 已经 700 多行,这块单独成文件
- `vn/voice.ts`、`vn/VNScreen.tsx` —— `ClipState` 多一个 `mode`,控制台的语音表显示「参考 / 向量 / 不控制」

## 数据

迁移脚本加两列(照 `scripts/migrate_connection_stream_column.py` 的写法,可以重复执行;新库靠 `create_all` 直接建好):
- `voice_profiles.ref_path`:TEXT,默认 `''`。音色参考,只有 IndexTTS 用
- `voice_emotions.emo_vector`:JSON,可以为空。8 维向量

连接:
- `tts_connections.api_type` 多一个值 `indextts`
- `options["emo_alpha"]`:默认 1.0,范围 0–1,只有 IndexTTS 用(小服务自己的默认是 0.6,但 AnimaVN 每次都会显式传)
- `sample_steps` 只对 GSV 有意义,IndexTTS 的连接忽略它,界面上也不显示

## 规则

### 组装一次合成(`_voice_for`)

1. 找情绪行的规则不变:立绘表情名或别名对上哪一行就用哪一行,都对不上用第一行
2. GSV:和现在一样;`check()` 要求这一行有参考路径和原文。情绪行一行都没有时,还是报「还没有参考音频」
3. IndexTTS:
   - 音色参考 = 声音的 `ref_path`,没填就报 400「声音「X」还没填音色参考」
   - 情绪:这一行填了 `ref_path` → 情绪参考(模式 `ref`);没填但有 `emo_vector` → 向量(模式 `vector`);都没有或者没有情绪行 → 不控制(模式 `none`)
   - 情绪行不需要填原文
   - `duration_factor = 1 / speed`,限制在 0.5–2.0,保留 3 位小数
   - `lang` 取声音的 `text_lang`
4. 响应头 `X-TTS-Emotion` 是实际用的情绪行名字(没有情绪行时为空);`X-TTS-Emo-Mode` 取 `ref` / `vector` / `none`,GSV 固定是 `ref`

### 向量校验(后端存之前就检查,不等服务端报错)

- 必须正好 8 个数,每个在 0–1.2 之间,加起来不超过 1.5;不合格返回 400,说明是哪一项的问题
- 全是 0 的向量存成空(等于不控制)

### 缓存

- 缓存键原料:`{"engine": "indextts", "body": <发给小服务的请求体>}`。请求体里已经包含音色参考、情绪参考或向量、强度、语速、语言,改了哪一项都会换一个键
- IndexTTS 采样本身有随机性,所以照样要缓存,理由和 GSV 一样

### 报错映射(`IndexTtsEngine`)

| 情况 | 后端返回 |
|---|---|
| 小服务返回 400 / 500 | 502,`detail` 原样透传 |
| 连不上 | 503「连不上语音服务 <地址>」 |
| 超时 | 504「语音合成超时」 |
| `/health` 返回 `ready: false` | 503「IndexTTS 还在加载模型」 |

### 默认向量表(`emotion_presets.py`)

按立绘的表情名和它的所有别名查(不分大小写),第一个对上的为准:

| 表情名 / 别名 | 向量(没写的维度是 0) |
|---|---|
| 平静、normal、calm、neutral、说话、talk、默认 | 不控制 |
| 微笑、smile | 高兴 0.4、平静 0.4 |
| 开心、高兴、happy | 高兴 0.8 |
| 温柔、gentle | 高兴 0.3、平静 0.5 |
| 认真、serious | 愤怒 0.1、平静 0.6 |
| 担心、worried | 害怕 0.4、忧郁 0.3 |
| 难过、伤心、sad | 悲伤 0.8 |
| 哭、cry | 悲伤 1.0 |
| 惊讶、surprised | 惊讶 0.8 |
| 慌张、flustered | 害怕 0.4、惊讶 0.4 |
| 害羞、脸红、shy | 高兴 0.3、害怕 0.3 |
| 疑惑、confused | 惊讶 0.4、平静 0.3 |
| 生气、angry | 愤怒 0.7 |
| 害怕、afraid、scared | 害怕 0.8 |
| 厌恶、嫌弃、disgusted | 厌恶 0.7 |
| 忧郁、失落、melancholic | 忧郁 0.7 |

- 立绘名对不上表里任何一项,但它的别名对得上,就按别名来。比如阿米娅的「红瞳」别名里有 `angry`,就得到愤怒 0.7
- 都对不上(比如琴柳的「持旗」)→ 不控制,留给用户自己填
- 这些数都只是起点,要以用户试听为准

### 按立绘表情补齐情绪行

`POST /api/voices/{profile_id}/emotions/from-sprites {card_id}` → 返回这个声音全部的情绪行。

- 按这张卡的立绘顺序,每个立绘表情一行:名字是立绘的表情名,不带别名,向量从默认表查
- 已经有的情绪行(名字或别名对上立绘表情名或它的别名)不动,只加缺的行
- 新加的行排在最后。这个声音原来一行都没有时,顺序照立绘排,立绘的第一个表情(立绘层的默认表情)就排第一
- 只对 IndexTTS 的声音开放;GSV 的声音调用返回 400「GSV 的情绪行要配参考音频,不能自动生成」

### refs.json

- 顶层可选 `speaker_ref`:音色参考。导入到 IndexTTS 的连接时,没写就用 `refs` 第一条的文件
- `refs` 里每条可选 `emo_vector`
- 导入到 IndexTTS 的连接时,`text` 可以不写。GSV 照旧必填

## 界面

### 语音页

- 新建语音服务时选引擎:GPT-SoVITS / IndexTTS-2.5。建好以后不能改引擎(引擎一换,声音的配置就对不上了)。IndexTTS 默认地址是 `http://127.0.0.1:9890`
- IndexTTS 的连接:不显示「采样步数」,改显示「情绪强度」(0–1,步长 0.05)
- IndexTTS 的声音:不显示 GPT / SoVITS 权重,改成「音色参考」路径
- IndexTTS 的情绪表,每行:名字、别名、情绪参考(可选;填了就不用向量,向量那栏变灰)、8 个数值、试听
  - 8 个数值用小的数字输入框,标签是「喜 怒 哀 惧 厌 郁 惊 平」,悬停显示全称;旁边显示「合计 x.x / 1.5」,超了标红,不能保存
- 当前有选中的卡、声音是 IndexTTS 时,显示「按这张卡的立绘表情补齐」按钮
- GSV 的声音界面保持原样

### 视觉小说控制台

语音表多一列「情绪方式」:参考 / 向量 / 不控制。

## 测试

后端(pytest):
- 在 `tests/conftest.py` 里加一个假的 IndexTTS 服务,写法和 `FakeGsv` 一样用 `httpx.MockTransport`:记下收到的请求体,可以让它返回 400 / 500 / 连不上 / 超时
- 请求体:参考 / 向量 / 不控制三种;语速换算和上下限;`lang`
- 检查规则:IndexTTS 没填音色参考报 400;GSV 的检查文案和原来一样(原有测试要照样通过)
- 报错映射:400 / 500 → 502,连不上 → 503,超时 → 504,`ready: false` → 503
- 缓存:换向量、换强度都会换键;命中缓存时不请求服务
- 向量校验:长度、单项范围、总和、全 0 存成空
- 默认向量表:按名字查、按别名查、查不到
- 按立绘补齐:只补缺的、顺序、GSV 的声音返回 400
- refs.json:`speaker_ref`、`emo_vector`、IndexTTS 不要求 `text`
- 迁移脚本:能重复执行,已有数据不丢(加进 `tests/test_migration_scripts.py`)
- 响应头 `X-TTS-Emo-Mode`

前端:`npm run build`、`npm run lint`,浏览器里对着假数据或真服务跑一遍。

## 没做 / 之后再聊

- 情绪文本(`use_emo_text`,读台词自己判断)、流式输出
- 按情绪行分别设强度:先全局一个值,试听后要是需要再加
- 自动调向量、情绪参考素材库
- 用 IndexTTS 替换 GSV:等用户试听对比完再说
- Tailscale、跨机访问(改连接地址就行,代码不用动)
