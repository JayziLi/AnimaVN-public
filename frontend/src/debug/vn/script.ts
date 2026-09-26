/**
 * 把一条 AI 回复切成视觉小说的一句一句,并记下每个立绘标签落在哪一句。
 *
 * 切分规则(不要求模型改写法,酒馆预设写出来的正文直接能用):
 *   1. 先按标签模板把标签全部摘掉(立绘、背景、音乐几类一起),同时记住每个标签
 *      在「摘完后的正文」里的位置
 *   2. 按换行分段;段内「」“”『』"" 包起来的是台词,归角色;其余是旁白。
 *      引号紧跟在汉字、字母、数字后面的不算(「眼神里写满了「我就知道」」「印着「RHODES
 *      ISLAND」的肩带」),那是旁白里的强调或专有名词 —— 台词前面总有标点、空白或者就在段首
 *   3. 台词前紧挨着「名字：」的,说话人用这个名字(一张卡里有多个角色时有用)
 *   4. 太长的一段按句号再切,免得一句塞满整个对话框
 *
 * 标签对哪一句生效:位置落在某句结束之前的标签,从那一句开始生效。
 * 所以不论模型把标签写在句首、句中还是单独占一行,都会作用到紧跟在它后面的那句。
 *
 * 谁在说话,切完再按标签校一遍(见 attributeSpans):
 *   - <我> 落到的那句是玩家({{user}})说的
 *   - 回复里有立绘标签时,角色的台词必须自己带立绘标签才算角色的 —— 模型替玩家写的
 *     台词常常不写「名字：」,不这样就会被当成角色的台词、用角色的声音念出来
 */

export interface VNLine {
  /** 说话人;旁白是 null */
  speaker: string | null;
  text: string;
  /** 外语插件:这句上面那行日语(配音用,小字显示);没有就不带这个字段 */
  ja?: string;
  /** 外语插件:这句本身就是日语(模型只写了日语、没写中文) */
  jaOnly?: boolean;
  /** 玩家台词插件:这句前面写了 <我>,是玩家说的(speaker 是玩家名字)。不念,翻到时弹选项 */
  player?: boolean;
  /** 回复里有立绘标签、这句台词却没带,不算角色的台词:speaker 是 null,不念、不切立绘 */
  untagged?: boolean;
}

/** 一类标签:立绘 / 背景 / 音乐,各有各的模板 */
export interface TagKind {
  kind: string;
  /** buildTagRegExp() 的结果;模板不合法时为 null,这一类就不认 */
  pattern: RegExp | null;
  /** 模板里占位符前面那段,用来识别流式时写了一半的标签 */
  prefix: string;
}

export interface TagHit {
  kind: string;
  /** 原文,比如 <sprite:开心> */
  raw: string;
  /** 标签里的名字 */
  label: string;
  /** 从第几句开始生效;-1 = 写在回复最末尾,之后没有句子了(会延续到下一条回复) */
  lineIndex: number;
  /** 生效的那一句的说话人(旁白是 null);写在回复末尾的没有 —— 立绘层靠它认出 NPC 台词前的标签 */
  speaker?: string | null;
}

export interface ParsedReply {
  lines: VNLine[];
  hits: TagHit[];
  /**
   * 每句在原文(带标签的那份)里结束的位置。插话时按它截断:只保留到玩家读到的那句,
   * 紧跟在这句后面的标签属于下一句,一起截掉
   */
  ends: number[];
}

/** 一句最多这么多字,超过就按句读再切 */
const MAX_LINE = 90;

const QUOTE_RE = /「[^」]*」?|『[^』]*』?|“[^”]*”?|"[^"\n]*"?/g;
/** 台词前的「名字：」 */
const NAME_PREFIX_RE = /^\s*([^\s，。！？、：:「」『』“”"*]{1,8})\s*[：:]\s*$/;
/**
 * 「她说：」「他低声道：」「她别过脸去：」这种是旁白引出台词,不是说话人名字。
 * 以代词开头、或者以说话类动词结尾的,都不当名字
 */
const NOT_A_NAME_RE = /^[她他它我你您]|(说|道|问|答|喊|叫|笑|嚷|吼|念|讲|语|想|唱)$/;
/** 引号前一个字是这些(汉字、字母、数字),引号就嵌在旁白句子里,不是台词 */
const EMBEDDED_AFTER_RE = /[\p{L}\p{N}]/u;
/** 只剩标点和空白的碎片(比如两句台词之间的「，」)不单独成句 */
const PUNCT_ONLY_RE = /^[\s，。、；：:;,.!！?？…—~～\-*]*$/;

interface Span {
  start: number;
  end: number;
  speaker: string | null;
  /** 同一次 splitLong 切出来的几块同一个号 —— 按标签认说话人时整句一起算 */
  group: number;
}

/** 把一段过长的文本按句读切开,每块不超过 MAX_LINE(实在没有句读就硬切) */
function splitLong(text: string, start: number): { start: number; end: number }[] {
  if (text.length <= MAX_LINE) return [{ start, end: start + text.length }];
  const out: { start: number; end: number }[] = [];
  let chunkStart = 0;
  let lastBreak = -1;
  for (let i = 0; i < text.length; i++) {
    if ('。！？!?…'.includes(text[i]) && !'。！？!?…」』”'.includes(text[i + 1] ?? '')) {
      lastBreak = i + 1;
    }
    if (i + 1 - chunkStart >= MAX_LINE) {
      const cut = lastBreak > chunkStart ? lastBreak : i + 1;
      out.push({ start: start + chunkStart, end: start + cut });
      chunkStart = cut;
      lastBreak = -1;
    }
  }
  if (chunkStart < text.length) out.push({ start: start + chunkStart, end: start + text.length });
  return out;
}

function splitParagraph(
  para: string,
  offset: number,
  charName: string,
  nextGroup: () => number,
): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  let pendingSpeaker: string | null = null;

  const pushNarration = (from: number, to: number) => {
    const piece = para.slice(from, to);
    if (PUNCT_ONLY_RE.test(piece)) return;
    const group = nextGroup();
    for (const c of splitLong(piece, offset + from)) spans.push({ ...c, speaker: null, group });
  };

  for (const m of para.matchAll(QUOTE_RE)) {
    const at = m.index ?? 0;
    // 旁白里的强调:留在旁白里,cursor 不动,后面一起并进旁白
    if (at > 0 && EMBEDDED_AFTER_RE.test(para[at - 1])) continue;
    const before = para.slice(cursor, at);
    const named = NAME_PREFIX_RE.exec(before);
    if (named && !NOT_A_NAME_RE.test(named[1])) {
      pendingSpeaker = named[1];
    } else {
      pushNarration(cursor, at);
    }
    const speaker = pendingSpeaker ?? charName;
    pendingSpeaker = null;
    const group = nextGroup();
    for (const c of splitLong(m[0], offset + at)) spans.push({ ...c, speaker, group });
    cursor = at + m[0].length;
  }
  pushNarration(cursor, para.length);
  return spans;
}

/**
 * 流式输出时,正文末尾可能是写了一半的标签(比如「<spri」),这时它还匹配不上模板,
 * 会被当成正文闪一下再消失。所以末尾如果可能是标签的开头,先把它藏起来。
 */
function trimPartialTag(text: string, prefix: string): string {
  // 去掉前缀末尾的冒号再比:模型可能写成全角冒号或者 >(见 tagRegExp 的放宽规则)
  const core = prefix.replace(/[:：]\s*$/, '');
  if (!core) return text;
  const from = Math.max(0, text.length - prefix.length - 40);
  for (let i = from; i < text.length; i++) {
    const tail = text.slice(i);
    if (tail.includes('\n')) continue;
    // 尾巴是前缀的开头(<spr),或者已经写完前缀、表情名还没写完(<sprite:开)
    if (core.startsWith(tail) || tail.startsWith(core)) return text.slice(0, i);
  }
  return text;
}

export interface ExtractedTag {
  kind: string;
  raw: string;
  label: string;
  /** 在摘掉标签后的正文里的位置 */
  pos: number;
}

/**
 * 摘掉所有标签,记下每个标签的位置。返回的标签按位置排好;位置相同(标签紧挨着)
 * 的按 kinds 里的先后排 —— 背景排在音乐前面,<bgm:紧张><bg:走廊> 这种写法里
 * 背景自带的默认曲不会盖掉 AI 点的曲子。
 */
export function extractTags(
  raw: string,
  kinds: readonly TagKind[],
  streaming: boolean,
): { text: string; tags: ExtractedTag[] } {
  const found: { at: number; end: number; rank: number; kind: string; raw: string; label: string }[] = [];
  kinds.forEach((k, rank) => {
    if (!k.pattern) return;
    for (const m of raw.matchAll(new RegExp(k.pattern.source, 'g'))) {
      const at = m.index ?? 0;
      found.push({ at, end: at + m[0].length, rank, kind: k.kind, raw: m[0], label: m[1].trim() });
    }
  });
  found.sort((a, b) => a.at - b.at || a.rank - b.rank);

  let text = '';
  let last = 0;
  const tags: (ExtractedTag & { rank: number })[] = [];
  for (const f of found) {
    if (f.at < last) continue; // 和前一个标签重叠(两类模板长得像时),先到先得
    text += raw.slice(last, f.at);
    tags.push({ kind: f.kind, raw: f.raw, label: f.label, pos: text.length, rank: f.rank });
    last = f.end;
  }
  text += raw.slice(last);
  if (streaming) {
    for (const k of kinds) if (k.pattern) text = trimPartialTag(text, k.prefix);
  }
  tags.sort((a, b) => a.pos - b.pos || a.rank - b.rank);
  return { text, tags: tags.map(({ rank: _rank, ...t }) => t) };
}

/**
 * 按标签校正说话人(就地改 spans 的 speaker),返回每句的标记。lineIndexes[i] 是第 i 个
 * 标签落到的句子:
 *   1. <我> 落到的那句(整组)是玩家的:speaker 换成玩家名字
 *   2. 回复里只要有一个立绘标签,说话人是角色的句子就得自己带立绘标签(标签正好落在
 *      这组上)才算角色的;没带的 speaker 设成 null,不念、不切立绘,照常显示。
 *      写了「名字：」的 NPC 台词不受影响;一个立绘标签都没有的回复(开场白、没开立绘
 *      插件的预设)完全照旧
 */
function attributeSpans(
  spans: Span[],
  tags: readonly ExtractedTag[],
  lineIndexes: readonly number[],
  charName: string,
  userName: string,
): { player?: boolean; untagged?: boolean }[] {
  const groupsOf = (kind: string) =>
    new Set(
      tags.flatMap((t, i) =>
        t.kind === kind && lineIndexes[i] !== -1 ? [spans[lineIndexes[i]].group] : [],
      ),
    );
  const players = groupsOf('player');
  const tagged = groupsOf('sprite');
  const strict = tags.some((t) => t.kind === 'sprite');
  return spans.map((s) => {
    if (players.has(s.group)) {
      s.speaker = userName;
      return { player: true };
    }
    if (strict && s.speaker === charName && !tagged.has(s.group)) {
      s.speaker = null;
      return { untagged: true };
    }
    return {};
  });
}

export function parseReply(
  raw: string,
  opts: {
    charName: string;
    /** 玩家名字:<我> 落到的台词用它当说话人 */
    userName: string;
    tags: readonly TagKind[];
    streaming: boolean;
  },
): ParsedReply {
  // 1. 摘标签,记位置
  const { text, tags } = extractTags(raw, opts.tags, opts.streaming);

  // 2. 分段、切句
  const spans: Span[] = [];
  let offset = 0;
  let groups = 0;
  const nextGroup = () => groups++;
  for (const para of text.split('\n')) {
    if (para.trim()) spans.push(...splitParagraph(para, offset, opts.charName, nextGroup));
    offset += para.length + 1;
  }

  // 3. 标签落到句子上:从「结束位置在标签之后」的第一句开始生效
  const lineIndexes = tags.map((t) => spans.findIndex((s) => s.end > t.pos));

  // 4. 按标签校正说话人:玩家台词、没带立绘标签的台词
  const marks = attributeSpans(spans, tags, lineIndexes, opts.charName, opts.userName);

  const lines: VNLine[] = spans.map((s, i) => ({
    speaker: s.speaker,
    // markdown 的强调星号在对话框里没有意义,酒馆式 *动作描写* 去掉星号留文字
    text: text.slice(s.start, s.end).replace(/\*+/g, '').trim(),
    ...marks[i],
  }));

  // 立绘层靠 hit 的 speaker 认出不是角色的台词(玩家的也是),用校正过的
  const hits: TagHit[] = tags.map((t, i) => {
    const lineIndex = lineIndexes[i];
    return {
      kind: t.kind,
      raw: t.raw,
      label: t.label,
      lineIndex,
      speaker: lineIndex === -1 ? undefined : spans[lineIndex].speaker,
    };
  });

  // 5. 句尾换算回原文位置:摘掉的标签里,位置在句尾之前的那些长度要加回去
  const ends = spans.map((s) =>
    tags.reduce((at, t) => (t.pos < s.end ? at + t.raw.length : at), s.end),
  );

  return { lines, hits, ends };
}
