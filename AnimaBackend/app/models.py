import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ApiConnection(Base):
    """A user-defined LLM API connection profile (SillyTavern-style)."""

    __tablename__ = "api_connections"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    api_type: Mapped[str] = mapped_column(String(32))  # "openai_compatible" | "anthropic" | "mock"
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model: Mapped[str] = mapped_column(String(200), default="")
    cached_models: Mapped[list] = mapped_column(JSON, default=list)
    cached_models_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=False)
    # per-connection because support is a property of the endpoint, not of us:
    # plenty of relays advertise the OpenAI dialect but choke on stream=True
    stream: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class TavernCard(Base):
    """A SillyTavern character card (V2/V3), stored field-for-field.

    The card is prompt material only; presentation (sprites, scene packs, voices)
    hangs off it in separate tables keyed by card_id.
    """

    __tablename__ = "tavern_cards"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    personality: Mapped[str] = mapped_column(Text, default="")
    scenario: Mapped[str] = mapped_column(Text, default="")
    first_mes: Mapped[str] = mapped_column(Text, default="")
    mes_example: Mapped[str] = mapped_column(Text, default="")
    # these two override the preset's main / jailbreak blocks at assembly time
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    post_history_instructions: Mapped[str] = mapped_column(Text, default="")
    creator_notes: Mapped[str] = mapped_column(Text, default="")
    alternate_greetings: Mapped[list] = mapped_column(JSON, default=list)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    creator: Mapped[str] = mapped_column(String(200), default="")
    character_version: Mapped[str] = mapped_column(String(60), default="")
    character_book: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    extensions: Mapped[dict] = mapped_column(JSON, default=dict)
    spec: Mapped[str] = mapped_column(String(40), default="chara_card_v2")
    # data: URL of the card's PNG; served separately so list responses stay light
    avatar: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 这张卡上次打开的对话 —— 对齐 ST 存在角色身上的 `character.chat`。
    # 没有它就只能按 updated_at 挑「最近改过的」,那不是「上次打开的」:
    # 光是读一条旧对话不会动 updated_at,切走再切回来就会跳到别的对话上。
    # 故意不加 FK:对话可以先于卡被删,悬空的指针在读取侧回退到最近一条。
    last_chat_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class CardSprite(Base):
    """立绘插件:一张角色卡上的一条「表情名 → 立绘图」映射。

    AI 在正文里写的是 label(或 aliases 里的任何一个),前端按它找到这一行的图。
    表情名只属于这张卡 —— 每个角色的差分不一样;标签格式是全局的,在 AppSetting 里。

    图直接存成 BLOB,而不是落盘文件:部署脚本的备份只拷数据库,单独的素材目录
    会被漏掉;删卡时连行一起删就行,不用另外管文件的生命周期。
    image 列是 deferred 的 —— 列映射表时不会把图一起拖出来,只有取图的端点才读它。
    """

    __tablename__ = "card_sprites"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    card_id: Mapped[str] = mapped_column(ForeignKey("tavern_cards.id"), index=True)
    label: Mapped[str] = mapped_column(String(80))
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    # 给 AI 看的一句用法说明,{{sprites}} 宏展开时跟在表情名后面
    description: Mapped[str] = mapped_column(Text, default="")
    image: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    mime: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # 排第一的是默认表情:一条回复里还没出现标签时用它
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class AppSetting(Base):
    """全局设置的键值表,目前只存插件配置(比如 plugin.sprite)。

    存在库里而不是 localStorage:标签格式决定前端怎么解析 AI 的输出,
    手机和电脑必须读到同一份,否则会出现一边能解析、另一边解析不了的情况。
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class ScenePack(Base):
    """场景包:一组背景 + BGM,给视觉小说的背景插件和 BGM 插件用。

    和立绘不同,场景素材不属于某张卡:同一个世界观的角色(比如罗德岛上的干员)
    共用一套场景和音乐,一首曲子几 MB,没必要每张卡存一份。卡通过
    CardScenePack 绑定一个包,多张卡可以绑同一个。
    """

    __tablename__ = "scene_packs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class SceneAsset(Base):
    """场景包里的一条素材:背景图(kind=bg)或背景音乐(kind=bgm)。

    和立绘一样,AI 在正文里写 label(或 aliases 里的任何一个),前端按它找到这一行。
    文件存 BLOB(理由同 CardSprite),data 列 deferred。
    """

    __tablename__ = "scene_assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    pack_id: Mapped[str] = mapped_column(ForeignKey("scene_packs.id"), index=True)
    kind: Mapped[str] = mapped_column(String(8))  # "bg" | "bgm"
    label: Mapped[str] = mapped_column(String(80))
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    mime: Mapped[str | None] = mapped_column(String(40), nullable=True)
    size: Mapped[int] = mapped_column(Integer, default=0)
    # 同类素材里排第一的是默认:对话里还没出现背景标签时用它
    sort: Mapped[int] = mapped_column(Integer, default=0)
    # 仅背景:竖屏只看得到横图中间一窄条,这个百分比决定对准哪儿(0 最左,100 最右)
    focus_x: Mapped[int] = mapped_column(Integer, default=50)
    # 仅背景:换到这个场景时自动换上的曲子(同一个包里的一条 bgm)
    bgm_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class CardScenePack(Base):
    """角色卡 → 场景包。单独一张表而不是给 tavern_cards 加列:建表靠 create_all,
    它不会给已有的表补列。"""

    __tablename__ = "card_scene_packs"

    card_id: Mapped[str] = mapped_column(ForeignKey("tavern_cards.id"), primary_key=True)
    pack_id: Mapped[str] = mapped_column(ForeignKey("scene_packs.id"), index=True)


class TtsConnection(Base):
    """语音插件:一个语音合成服务(目前只有 GPT-SoVITS api_v2)。

    和 LLM 的 ApiConnection 分开放:字段几乎不重合(没有 key / model,多了采样步数)。
    """

    __tablename__ = "tts_connections"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    api_type: Mapped[str] = mapped_column(String(32), default="gpt_sovits")
    base_url: Mapped[str] = mapped_column(String(500))
    # GPT-SoVITS v3/v4 的采样步数。用户试听选了 64:比 32 慢一半,听感更好
    sample_steps: Mapped[int] = mapped_column(Integer, default=64)
    # 留给以后别的引擎放自己的参数
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class VoiceProfile(Base):
    """一个声音:用哪个语音服务、哪套模型权重。

    权重和参考音频都在语音服务那台机器上,这里只存路径 —— api_v2 只认服务端本地路径,
    没有上传接口。和场景包一样不属于某张卡,通过 CardVoice 绑定。
    """

    __tablename__ = "voice_profiles"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    # 台词前写「名字：」时,按名字 / 别名找声音
    name: Mapped[str] = mapped_column(String(80))
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    connection_id: Mapped[str] = mapped_column(ForeignKey("tts_connections.id"), index=True)
    gpt_weights: Mapped[str] = mapped_column(String(500), default="")
    sovits_weights: Mapped[str] = mapped_column(String(500), default="")
    # IndexTTS 的音色参考(语音服务那台机器上的路径)。GSV 不用:音色在权重里
    ref_path: Mapped[str] = mapped_column(String(500), default="")
    text_lang: Mapped[str] = mapped_column(String(12), default="zh")
    speed: Mapped[float] = mapped_column(Float, default=1.0)
    # 调过的合成参数(schemas.VoiceParams,只存调过的项);空 = 全用默认
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class VoiceEmotion(Base):
    """声音的一种情绪 = 一段参考音频 + 它的原文。GPT-SoVITS 的语气跟着参考音频走,
    所以换情绪就是换参考。

    IndexTTS 的声音:ref_path 是可选的情绪参考(可以是别的角色的声音),不需要原文;
    没填情绪参考时用 emo_vector,两个都没有就沿用音色参考的语气。

    label / aliases 和立绘的表情名对应:这句生效的立绘表情是「开心」,就用叫「开心」的
    这一行;对不上就用排第一的(默认)。
    """

    __tablename__ = "voice_emotions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    profile_id: Mapped[str] = mapped_column(ForeignKey("voice_profiles.id"), index=True)
    label: Mapped[str] = mapped_column(String(80))
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    ref_path: Mapped[str] = mapped_column(String(500), default="")
    # 参考音频里说的话,要一字不差
    prompt_text: Mapped[str] = mapped_column(Text, default="")
    # IndexTTS 的 8 维情绪向量 [高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静];空 = 不用向量
    emo_vector: Mapped[list | None] = mapped_column(JSON, nullable=True, default=None)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class CardVoice(Base):
    """角色卡 → 声音。每张卡最多一个主声音(念这张卡角色自己的台词);其他声音
    在台词前的「名字：」对上时才念(一张卡里有好几个角色时)。"""

    __tablename__ = "card_voices"

    card_id: Mapped[str] = mapped_column(ForeignKey("tavern_cards.id"), primary_key=True)
    profile_id: Mapped[str] = mapped_column(
        ForeignKey("voice_profiles.id"), primary_key=True, index=True
    )
    is_main: Mapped[bool] = mapped_column(default=False)


class TtsCache(Base):
    """合成过的语音。GPT-SoVITS 每次请求的随机种子不同,同一句重算语气会变;回看、重播
    要听到同一段,所以按「权重 + 请求体」的哈希存下来。data 列 deferred,统计时不拖出来。"""

    __tablename__ = "tts_cache"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    mime: Mapped[str] = mapped_column(String(40))
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class PromptPreset(Base):
    """A SillyTavern Chat Completion preset, stored as-is.

    prompts = the block library; prompt_order = which blocks are used and in what
    order, grouped by character_id. Both kept raw so a preset round-trips through
    us unchanged.
    """

    __tablename__ = "prompt_presets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200))
    prompts: Mapped[list] = mapped_column(JSON, default=list)
    prompt_order: Mapped[list] = mapped_column(JSON, default=list)
    formats: Mapped[dict] = mapped_column(JSON, default=dict)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    squash_system_messages: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class DebugChat(Base):
    """A prompt-console chat. Columns shadow the SillyTavern chat jsonl header
    (user_name / character_name / tainted), plus a parent pointer reserved for
    branch-from-here.

    card_id / preset_id are SET NULL by the delete endpoints (not by the FK
    itself — SQLite only enforces that with a per-connection pragma we don't
    set): the chat outlives its card because every swipe carries a full prompt
    snapshot. The frozen *_name columns keep the list readable afterwards.
    """

    __tablename__ = "debug_chats"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), default="")
    card_id: Mapped[str | None] = mapped_column(
        ForeignKey("tavern_cards.id"), nullable=True, index=True
    )
    preset_id: Mapped[str | None] = mapped_column(ForeignKey("prompt_presets.id"), nullable=True)
    card_name: Mapped[str] = mapped_column(String(200), default="")
    preset_name: Mapped[str] = mapped_column(String(200), default="")
    user_name: Mapped[str] = mapped_column(String(120), default="User")
    # pristine greeting vs edited chat — decides right-swipe behavior, like ST
    tainted: Mapped[bool] = mapped_column(default=False)
    # batch 4 (branch-from-here): the chat this one was forked from, and the
    # message it forked at. No FK on purpose — deleting a parent promotes the
    # children back to roots in the tree instead of cascading.
    parent_chat_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    parent_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class DebugChatMessage(Base):
    """One message row of a debug chat. The id is the frontend entry's UUID —
    stable across saves, so the console can upsert single rows per operation
    instead of rewriting the whole chat.

    swipes / swipe_id / swipe_info mirror the ST jsonl fields one-to-one.
    swipe_info entries arrive with an embedded prompt snapshot; the API strips
    it into debug_snapshots and leaves only the hash behind.
    """

    __tablename__ = "debug_chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey("debug_chats.id"), index=True)
    idx: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(20))  # "user" | "assistant"
    swipes: Mapped[list] = mapped_column(JSON, default=list)
    swipe_id: Mapped[int] = mapped_column(Integer, default=0)
    swipe_info: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class DebugSnapshot(Base):
    """A prompt snapshot, content-addressed by its hash.

    Regenerations usually resend the identical prompt, so the same hash recurs
    across swipes and messages — storing it once keeps long chats small.
    """

    __tablename__ = "debug_snapshots"

    hash: Mapped[str] = mapped_column(String(16), primary_key=True)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Persona(Base):
    """玩家人设(SillyTavern Persona Management 的对应物):名字 + 描述,
    激活的那一个决定 {{user}} 宏替换成谁、以及系统提示词里的玩家段落。
    """

    __tablename__ = "personas"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    # data URL,和角色卡头像一个存法(酒馆那边是 512×768 的 png 文件)
    avatar: Mapped[str | None] = mapped_column(Text, default=None)
    is_active: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
