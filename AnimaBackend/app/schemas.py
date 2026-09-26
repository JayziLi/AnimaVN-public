from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ApiType = Literal["openai_compatible", "anthropic", "mock"]


class PersonaCreate(BaseModel):
    name: str
    description: str = ""
    avatar: str | None = None


class PersonaUpdate(BaseModel):
    """Partial update: omitted fields keep their current value."""

    name: str | None = None
    description: str | None = None
    # 显式传 null = 清掉头像,所以这个字段靠 exclude_unset 区分"没传"和"清空"
    avatar: str | None = None


class PersonaOut(BaseModel):
    id: str
    name: str
    description: str
    avatar: str | None
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ConnectionCreate(BaseModel):
    name: str
    api_type: ApiType
    base_url: str | None = None
    api_key: str | None = None
    model: str = ""
    stream: bool = True


class ConnectionUpdate(BaseModel):
    """Partial update: omitted fields keep their current value.

    api_key: omit to keep the stored key, send "" or null to clear it.
    """

    name: str | None = None
    api_type: ApiType | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    stream: bool | None = None


class ConnectionOut(BaseModel):
    id: str
    name: str
    api_type: str
    base_url: str | None
    model: str
    has_api_key: bool
    is_active: bool
    stream: bool
    cached_models: list[str]
    cached_models_at: datetime | None


class ConnectionTestResult(BaseModel):
    ok: bool
    message: str


class ModelsPreviewRequest(BaseModel):
    """Fetch remote model list for a possibly-unsaved connection config.

    api_key omitted/empty + connection_id set = use that connection's stored key.
    """

    api_type: ApiType
    base_url: str | None = None
    api_key: str | None = None
    connection_id: str | None = None


class TestMessageRequest(BaseModel):
    content: str


class TestMessageResult(BaseModel):
    reply: str


# ── 酒馆角色卡 ──────────────────────────────────────────────
# 字段照搬 chara_card_v2/v3 spec，命名保持一致，方便原样进出。


class TavernCardBase(BaseModel):
    name: str = ""
    description: str = ""
    personality: str = ""
    scenario: str = ""
    first_mes: str = ""
    mes_example: str = ""
    system_prompt: str = ""
    post_history_instructions: str = ""
    creator_notes: str = ""
    alternate_greetings: list[str] = []
    tags: list[str] = []
    creator: str = ""
    character_version: str = ""
    character_book: dict | None = None
    extensions: dict = {}
    spec: str = "chara_card_v2"


class TavernCardCreate(TavernCardBase):
    avatar: str | None = None


class TavernCardUpdate(BaseModel):
    """All optional — the console PATCHes single fields as the user types."""

    name: str | None = None
    description: str | None = None
    personality: str | None = None
    scenario: str | None = None
    first_mes: str | None = None
    mes_example: str | None = None
    system_prompt: str | None = None
    post_history_instructions: str | None = None
    creator_notes: str | None = None
    alternate_greetings: list[str] | None = None
    tags: list[str] | None = None
    creator: str | None = None
    character_version: str | None = None
    character_book: dict | None = None
    extensions: dict | None = None
    spec: str | None = None
    avatar: str | None = None
    # 上次打开的对话。显式传 null 就是清空 —— exclude_unset 认的是「键在不在
    # 请求体里」,不是值是不是 None,所以和 avatar/character_book 一样能置空
    last_chat_id: str | None = None


class TavernCardOut(TavernCardBase):
    id: str
    # avatar itself is fetched from /avatar so listing many cards stays cheap
    has_avatar: bool
    last_chat_id: str | None = None
    created_at: datetime
    updated_at: datetime


# ── 提示词预设 ──────────────────────────────────────────────


class PromptPresetBase(BaseModel):
    name: str
    prompts: list[dict] = []
    prompt_order: list[dict] = []
    formats: dict = {}
    params: dict = {}
    squash_system_messages: bool = False


class PromptPresetCreate(PromptPresetBase):
    pass


class PromptPresetUpdate(BaseModel):
    name: str | None = None
    prompts: list[dict] | None = None
    prompt_order: list[dict] | None = None
    formats: dict | None = None
    params: dict | None = None
    squash_system_messages: bool | None = None


class PromptPresetOut(PromptPresetBase):
    id: str
    created_at: datetime
    updated_at: datetime


class DuplicateRequest(BaseModel):
    """Optional new name for the copy; falls back to '<原名> - 副本'."""

    name: str | None = None


# ── 调试台对话 ──────────────────────────────────────────────
# 消息字段刻意贴着酒馆 chat jsonl(swipes / swipe_id / extra)。
# swipe_info 是不透明 JSON:前端往里放什么就存什么,快照除外 —— 写入时
# 被抽进 debug_snapshots,库里只留 snapshotHash。


class DebugChatCreate(BaseModel):
    name: str = ""
    card_id: str | None = None
    preset_id: str | None = None
    user_name: str = "User"


class DebugChatUpdate(BaseModel):
    """Partial update. card_id / preset_id: send null to clear, omit to keep."""

    name: str | None = None
    card_id: str | None = None
    preset_id: str | None = None
    user_name: str | None = None
    tainted: bool | None = None


class DebugChatMessageIn(BaseModel):
    id: str
    idx: int
    role: str  # "user" | "assistant"
    swipes: list[str]
    swipe_id: int = 0
    swipe_info: list[dict] = []


class DebugChatMessageOut(BaseModel):
    id: str
    idx: int
    role: str
    swipes: list[str]
    swipe_id: int
    swipe_info: list[dict]


class DebugChatOut(BaseModel):
    id: str
    name: str
    card_id: str | None
    preset_id: str | None
    card_name: str
    preset_name: str
    user_name: str
    tainted: bool
    parent_chat_id: str | None = None
    parent_message_id: str | None = None
    created_at: datetime
    updated_at: datetime
    # 列表视图给个数,详情视图给全量消息 —— 二者互斥
    message_count: int | None = None
    messages: list[DebugChatMessageOut] | None = None
    # 列表卡片的预览行:最后一条消息的正文(已压平空白并截断)
    last_message: str = ""


class DebugBranchRequest(BaseModel):
    """从这里开始:复制 [0, message_id] 到新对话。"""

    message_id: str


# ── 立绘插件 ──────────────────────────────────────────────


class CardSpriteCreate(BaseModel):
    label: str
    aliases: list[str] = []
    description: str = ""


class CardSpriteUpdate(BaseModel):
    """全部可选 —— 映射表是逐格编辑的,一次只改一个字段。"""

    label: str | None = None
    aliases: list[str] | None = None
    description: str | None = None


class CardSpriteOut(BaseModel):
    id: str
    card_id: str
    label: str
    aliases: list[str]
    description: str
    has_image: bool
    # 图的版本号(毫秒时间戳),前端拼进图片 URL 当缓存键 —— 换图后 URL 变了,
    # 浏览器就不会继续用缓存里的旧图
    image_version: int
    sort: int


class SpriteReorderRequest(BaseModel):
    """这张卡全部立绘的 id,按新顺序排。必须一个不多一个不少。"""

    ids: list[str]


# ── 场景包(背景 + BGM 插件) ────────────────────────────────


class ScenePackIn(BaseModel):
    name: str
    description: str = ""


class ScenePackUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ScenePackOut(BaseModel):
    id: str
    name: str
    description: str
    bg_count: int
    bgm_count: int
    # 绑了这个包的卡有几张 —— 删包前让人心里有数
    card_count: int


SceneKind = Literal["bg", "bgm"]


class SceneAssetCreate(BaseModel):
    kind: SceneKind
    label: str
    aliases: list[str] = []
    description: str = ""


class SceneAssetUpdate(BaseModel):
    """全部可选,逐格编辑。bgm_id 显式传 null 表示「不要默认曲」。"""

    label: str | None = None
    aliases: list[str] | None = None
    description: str | None = None
    focus_x: int | None = Field(default=None, ge=0, le=100)
    bgm_id: str | None = None


class SceneAssetOut(BaseModel):
    id: str
    pack_id: str
    kind: SceneKind
    label: str
    aliases: list[str]
    description: str
    has_file: bool
    mime: str | None
    size: int
    # 文件版本号(毫秒时间戳),拼进 URL 当缓存键,和立绘的 image_version 一样
    file_version: int
    focus_x: int
    bgm_id: str | None
    sort: int


class SceneAssetReorder(BaseModel):
    """某一类素材(背景或 BGM)的全部 id,按新顺序排。"""

    kind: SceneKind
    ids: list[str]


class CardScenePackIn(BaseModel):
    pack_id: str | None


class CardScenePackOut(BaseModel):
    card_id: str
    pack_id: str | None


class AppSettingOut(BaseModel):
    key: str
    value: Any


class AppSettingIn(BaseModel):
    value: Any


# ── 语音插件 ──────────────────────────────────────────────

TtsApiType = Literal["gpt_sovits", "indextts"]


class TtsConnectionIn(BaseModel):
    name: str
    api_type: TtsApiType = "gpt_sovits"
    base_url: str
    sample_steps: int = Field(default=64, ge=4, le=128)
    # IndexTTS 的情绪强度;GSV 不用。用户试听:强度高的好,默认 1.0
    emo_alpha: float = Field(default=1.0, ge=0, le=1)


class TtsConnectionUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    sample_steps: int | None = Field(default=None, ge=4, le=128)
    emo_alpha: float | None = Field(default=None, ge=0, le=1)


class TtsConnectionOut(BaseModel):
    id: str
    name: str
    api_type: TtsApiType
    base_url: str
    sample_steps: int
    emo_alpha: float
    # 用这个服务的声音有几个 —— 删之前心里有数
    profile_count: int


class TtsTimingOut(BaseModel):
    """测试连接 / 预热花了多少毫秒"""

    ms: int


class VoiceEmotionIn(BaseModel):
    label: str
    aliases: list[str] = []
    ref_path: str = ""
    # 空着且文件名是「【情绪】原文.wav」时,从文件名取
    prompt_text: str = ""
    # IndexTTS 的 8 维情绪向量;顺序和范围见 app/tts/emotion_presets.py
    emo_vector: list[float] | None = None


class VoiceEmotionUpdate(BaseModel):
    label: str | None = None
    aliases: list[str] | None = None
    ref_path: str | None = None
    prompt_text: str | None = None
    # 传 null 是清空向量;不传是不动(靠 exclude_unset 区分)
    emo_vector: list[float] | None = None


class VoiceEmotionOut(BaseModel):
    id: str
    profile_id: str
    label: str
    aliases: list[str]
    ref_path: str
    prompt_text: str
    emo_vector: list[float] | None
    sort: int


TextSplitMethod = Literal["cut0", "cut1", "cut2", "cut3", "cut4", "cut5"]


class VoiceParams(BaseModel):
    """一个声音的合成参数。不给 = 用默认:采样步数、情绪强度跟语音服务,其余用引擎自己的默认。
    各引擎只取自己认的(IndexTTS 只认 emo_alpha)。界面上的说明见前端 plugins/voice.ts。"""

    # 拼错的参数名直接报错,不能悄悄当没调
    model_config = ConfigDict(extra="forbid")

    # GPT-SoVITS api_v2
    sample_steps: int | None = Field(default=None, ge=4, le=128)
    temperature: float | None = Field(default=None, gt=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    top_k: int | None = Field(default=None, ge=1, le=100)
    repetition_penalty: float | None = Field(default=None, ge=0, le=2)
    text_split_method: TextSplitMethod | None = None
    fragment_interval: float | None = Field(default=None, ge=0, le=2)
    parallel_infer: bool | None = None
    # IndexTTS
    emo_alpha: float | None = Field(default=None, ge=0, le=1)


class VoiceProfileIn(BaseModel):
    name: str
    aliases: list[str] = []
    connection_id: str
    gpt_weights: str = ""
    sovits_weights: str = ""
    # IndexTTS 的音色参考;GSV 不用
    ref_path: str = ""
    text_lang: str = Field(default="zh", max_length=12)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    params: VoiceParams = VoiceParams()


class VoiceProfileUpdate(BaseModel):
    name: str | None = None
    aliases: list[str] | None = None
    connection_id: str | None = None
    gpt_weights: str | None = None
    sovits_weights: str | None = None
    ref_path: str | None = None
    text_lang: str | None = Field(default=None, max_length=12)
    speed: float | None = Field(default=None, ge=0.5, le=2.0)
    # 整组替换:没带的项回到默认
    params: VoiceParams | None = None


class VoiceProfileOut(BaseModel):
    id: str
    name: str
    aliases: list[str]
    connection_id: str
    gpt_weights: str
    sovits_weights: str
    ref_path: str
    text_lang: str
    speed: float
    params: dict[str, Any]
    emotions: list[VoiceEmotionOut]
    card_count: int


class VoiceReorder(BaseModel):
    """这个声音全部情绪的 id,按新顺序排(排第一的是默认)。"""

    ids: list[str]


class VoiceImportIn(BaseModel):
    """语音服务那台机器上每个角色目录里的 refs.json,整份贴进来。格式见 docs/voice-server.md。"""

    connection_id: str
    refs: dict[str, Any]


class VoiceFromSpritesIn(BaseModel):
    """按这张卡的立绘表情补齐情绪行(只对 IndexTTS 的声音)。"""

    card_id: str


class CardVoicesIn(BaseModel):
    main: str | None = None
    extras: list[str] = []


class CardVoicesOut(BaseModel):
    card_id: str
    main: str | None
    extras: list[str]


class VoiceTuning(BaseModel):
    """试音台:这一句不用声音存着的语速、语言、参数,换成这一组(整组替换,不保存)。"""

    speed: float = Field(ge=0.5, le=2.0)
    text_lang: str = Field(min_length=1, max_length=12)
    params: VoiceParams = VoiceParams()
    # 固定随机种子:对比参数时两次用同一个数,差别就只来自参数。只有 GSV 认,也只在这里用
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)


class TtsSpeakIn(BaseModel):
    profile_id: str
    # 这句生效的立绘表情名;情绪表里对不上就用默认情绪
    emotion: str | None = None
    text: str = Field(min_length=1, max_length=500)
    # 重新生成:不看缓存,再合成一遍,新的这版替换缓存里的旧版
    fresh: bool = False
    tuning: VoiceTuning | None = None


class TtsExplainIn(BaseModel):
    """这句会怎么念(不合成),字段和 TtsSpeakIn 一样"""

    profile_id: str
    emotion: str | None = None
    text: str = Field(min_length=1, max_length=500)


class TtsExplainOut(BaseModel):
    """一句语音的来龙去脉:挑中哪一行情绪、怎么挑中的、发给语音服务的原样请求、缓存里有没有"""

    profile_name: str
    connection_name: str
    api_type: str
    # 要的情绪(立绘表情名);没传是 None
    wanted: str | None
    # 实际用的情绪行;IndexTTS 没有情绪行时是空串
    emotion: str
    # exact 名字对上 / alias 别名对上 / nearest 模型挑的最像的 / default 没传或对不上,用排第一的
    how: Literal["exact", "alias", "nearest", "default"]
    # alias:对上的别名;nearest:模型认为最像的那个名字(可能是别名)
    via: str | None = None
    # nearest:相似度
    score: float | None = None
    # 情绪从哪来:ref 参考音频 / vector 向量 / none 不控制
    mode: str
    # GSV 的模型权重(IndexTTS 为空串)
    gpt_weights: str
    sovits_weights: str
    # 发给语音服务的请求体,原样
    request: dict[str, Any]
    # 缓存里已经有这句(合成过,重播直接出)
    cached: bool


class TtsWarmupIn(BaseModel):
    profile_id: str
    # 不信任记住的「当前权重」,强制重新切(手动或用别的脚本切过权重之后)
    force: bool = False


class TtsCacheOut(BaseModel):
    count: int
    bytes: int
    limit_bytes: int
