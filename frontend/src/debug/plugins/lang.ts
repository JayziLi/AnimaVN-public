/**
 * 外语插件 —— 日语配音、中文字幕。
 *
 * 主模型按「一行日语,下一行是它的中文」交替写(旁白和台词都这样,不加标签)。这里做三件事:
 *   1. 认出日语行:带假名的行;兜底是「下一行和它一字不差」的那行(「……」「……」这种)
 *   2. 把日语从正文里摘掉,挂到它下面那句中文上;剩下的中文照原来的 parseReply 切句,
 *      规则一条不改
 *   3. 念哪种:看声音的 text_lang(speechText)
 *
 * 插件本身只有提示词模板和「显示日语」开关,全局一份,存在后端 app_settings(键 plugin.lang)。
 * 提示词块写进预设,identifier 固定为 anima_lang,正文跟着插件模板同步(和立绘插件一样)。
 * 规则见 docs/superpowers/specs/2026-09-25-lang-plugin-bilingual-design.md
 */

import type { PresetOrderEntry, TavernPreset } from '../lib/presetParser';
import { extractTags, parseReply, type ParsedReply, type TagKind, type VNLine } from '../vn/script';
import { insertPluginBlock, pluginBlockState, type BlockState } from './common';

export const LANG_SETTING_KEY = 'plugin.lang';
export const LANG_BLOCK_ID = 'anima_lang';

export const DEFAULT_LANG_BLOCK_PROMPT = `[双语输出]
这是日语配音、中文字幕的视觉小说。整条回复（旁白和台词）都要日中对照着写：
- 每一段先写一行日语，紧接着下一行写这段的中文。一行日语对应一行中文，先日后中。
- 台词单独成行，日语和中文都用「」括起来。
- 中文以日语为参考来写：保留一点翻译腔，同时通顺、自然、优美。
- 中文里不要夹杂假名；日语那一行不要写任何标签。
- 立绘、场景、音乐标签写在这一对（日语 + 中文）的前面。

示例：
<sprite:微笑>
「おかえり。今日も一日、お疲れさま。」
「欢迎回来。今天也辛苦啦。」

彼女はそう言って、ソファの端に寄って場所を空けた。
她说着，往沙发边上挪了挪，给他让出位置。`;

export interface LangPluginConfig {
  /** 「加入当前预设」时写进块里的内容;预设里的这块始终跟着它 */
  blockPrompt: string;
  /** 视觉小说里在中文上方显示日语 */
  showJa: boolean;
}

export const DEFAULT_LANG_CONFIG: LangPluginConfig = {
  blockPrompt: DEFAULT_LANG_BLOCK_PROMPT,
  showJa: true,
};

/** 后端存的是任意 JSON —— 缺字段或类型不对的就退回默认值 */
export function normalizeLangConfig(raw: unknown): LangPluginConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_LANG_CONFIG;
  return {
    blockPrompt: typeof r.blockPrompt === 'string' ? r.blockPrompt : d.blockPrompt,
    showJa: typeof r.showJa === 'boolean' ? r.showJa : d.showJa,
  };
}

export const langBlockState = (
  preset: TavernPreset | null,
  order: readonly PresetOrderEntry[],
): BlockState => pluginBlockState(preset, order, LANG_BLOCK_ID);

/** 把外语块加进预设(插在哪见 insertPluginBlock) */
export const insertLangBlock = (preset: TavernPreset, groupIndex: number, content: string) =>
  insertPluginBlock(preset, groupIndex, {
    identifier: LANG_BLOCK_ID,
    name: '外语指令 · 插件',
    content,
  });

// ---- 认日语 ----

/** 平假名、片假名(含长音「ー」;不含中文名字里也会用的间隔号「・」) */
const KANA_RE = /[ぁ-ゖゝ-ゟァ-ヺー-ヿㇰ-ㇿ]/;
export const hasKana = (text: string) => KANA_RE.test(text);

/** 声音的 text_lang 是不是日语(GSV 的 ja / all_ja) */
export const isJaLang = (lang: string) => /(^|_)ja$/i.test(lang.trim());

interface Row {
  /** 这一行在原文里的起止(不含换行符) */
  start: number;
  end: number;
  /** 摘掉标签、去掉首尾空白后的内容 */
  content: string;
  /** 这一行里的标签原文和它在原文里的位置 */
  tags: { raw: string; at: number }[];
  /** 空行(只有标签的也算) / 日语 / 正文 */
  kind: 'blank' | 'ja' | 'text';
}

function splitRows(raw: string, kinds: readonly TagKind[], streaming: boolean): Row[] {
  const parts = raw.split('\n');
  const rows: Row[] = [];
  let start = 0;
  parts.forEach((line, i) => {
    // 流式时只有最后一行可能写着半个标签
    const { text, tags } = extractTags(line, kinds, streaming && i === parts.length - 1);
    const content = text.trim();
    let from = 0;
    const found = tags.map((t) => {
      const at = line.indexOf(t.raw, from);
      from = at + t.raw.length;
      return { raw: t.raw, at: start + at };
    });
    rows.push({
      start,
      end: start + line.length,
      content,
      tags: found,
      kind: !content ? 'blank' : hasKana(content) ? 'ja' : 'text',
    });
    start += line.length + 1;
  });
  // 兜底:日语碰巧一个假名都没有(「……」、全是汉字的短句),模型会把同一行写两遍 ——
  // 下一行和它一字不差,前一行就是日语。整条回复一行日语都没有时不这么认,免得误伤纯中文
  if (rows.some((r) => r.kind === 'ja')) {
    rows.forEach((r, i) => {
      if (r.kind !== 'text') return;
      const next = rows.find((x, k) => k > i && x.kind !== 'blank');
      if (next && next.kind === 'text' && next.content === r.content) r.kind = 'ja';
    });
  }
  return rows;
}

/**
 * 切一条回复,同时把日语挂到句子上。没有日语的回复和 parseReply 完全一样。
 *
 * 日语行从正文里摘掉(行里的标签留在原位,仍然作用到下面那句中文),挂在它下面紧跟的
 * 那行中文切出来的第一句上。后面紧跟的还是日语、或者回复写完了也没有中文,这行日语
 * 就当正文显示(jaOnly)。流式时最后一行是正在写的日语,先追加一句空的中文带着它,
 * 中文开始写以后还是这一句(序号不变)。
 *
 * ends 换算回原文里的位置,插话截断直接用;日中交替写,截到哪句,后面的日语一起截掉。
 */
export function parseBilingual(
  raw: string,
  opts: { charName: string; userName: string; tags: readonly TagKind[]; streaming: boolean },
): ParsedReply {
  const rows = splitRows(raw, opts.tags, opts.streaming);
  if (!rows.some((r) => r.kind === 'ja')) return parseReply(raw, opts);

  // 每行日语的去向
  const jaOf = new Map<number, string>(); // 正文行 → 它上面的日语
  const orphan = new Set<number>(); // 没有中文的日语行:留在正文里
  let pending: string | null = null; // 流式:正在写、中文还没开始的日语
  rows.forEach((r, i) => {
    if (r.kind !== 'ja') return;
    const next = rows.findIndex((x, k) => k > i && x.kind !== 'blank');
    if (next !== -1 && rows[next].kind === 'text') jaOf.set(next, r.content);
    else if (next === -1 && opts.streaming) pending = r.content;
    else orphan.add(i);
  });

  // 摘掉日语后的文本,逐字记下它在原文里的位置
  let reduced = '';
  const map: number[] = [];
  const push = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) map.push(at + k);
    reduced += s;
  };
  const span: { from: number; to: number }[] = [];
  rows.forEach((r, i) => {
    const from = reduced.length;
    if (r.kind === 'ja' && !orphan.has(i)) {
      for (const t of r.tags) push(t.raw, t.at);
    } else {
      push(raw.slice(r.start, r.end), r.start);
    }
    span.push({ from, to: reduced.length });
    if (i < rows.length - 1) push('\n', r.end);
  });

  const parsed = parseReply(reduced, opts);
  // 每句来自哪一行:句尾落在哪行的范围里就是哪行;同一行切出好几句时,日语挂在第一句上
  const seen = new Set<number>();
  const lines: VNLine[] = parsed.lines.map((ln, k) => {
    const e = parsed.ends[k];
    const row = span.findIndex((s) => e > s.from && e <= s.to);
    const first = row !== -1 && !seen.has(row);
    if (row !== -1) seen.add(row);
    if (orphan.has(row)) return { ...ln, jaOnly: true };
    const ja = first ? jaOf.get(row) : undefined;
    return ja ? { ...ln, ja } : ln;
  });
  const ends = parsed.ends.map((e) => (e === 0 ? 0 : map[e - 1] + 1));
  if (pending !== null) {
    lines.push({ speaker: null, text: '', ja: pending });
    ends.push(raw.length);
  }
  return { lines, hits: parsed.hits, ends };
}

/**
 * 这句用这个语言的声音念什么;不念返回 null。
 * 日语声音念挂在这句上的日语(只有日语、没写中文的句子念它本身),缺日语就不念;
 * 其他语言的声音念中文,只有日语的句子不念
 */
export function speechText(line: VNLine, voiceLang: string): string | null {
  if (isJaLang(voiceLang)) return line.ja ?? (line.jaOnly ? line.text : null);
  return line.jaOnly ? null : line.text;
}
