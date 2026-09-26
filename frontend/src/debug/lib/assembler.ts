/**
 * 把 角色卡 + 预设 + 对话历史 组装成最终的 messages 数组。
 *
 * 复刻酒馆 Chat Completion 的组装顺序:
 *   遍历 prompt_order → 跳过 disabled → 找到块 → marker 展开成真实内容
 *   → 宏替换 → 产出消息
 *
 * 每条产出的消息都带 source 元数据,这是调试台能做「来源追溯」的原因。
 */

import type { TavernCard } from './cardParser';
import { stripComments } from './comments';
import { buildMacroContext, substituteMacros, type MacroContext } from './macros';
import { estimateTokens } from './tokens';
import {
  MARKER_LABELS,
  type PresetOrderEntry,
  type PresetPrompt,
  type PromptRole,
  type TavernPreset,
} from './presetParser';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * token 分账口径 —— 比 sourceKind 细,因为预算条要按来源分段染色。
 *
 * 和 sourceKind 唯一实质的差别在「卡覆盖预设块」:那时 sourceKind 仍是
 * preset(它确实占着预设块的位置),但字是从卡里来的,账要算到卡头上。
 */
export type PromptPart =
  | 'preset'
  | 'card'
  | 'persona'
  | 'examples'
  | 'worldInfo'
  | 'history';

/** 分账口径 → 预算条上的三段。条上只分三色,明细才铺开到 part */
export function bucketOf(part: PromptPart): 'preset' | 'card' | 'history' {
  if (part === 'preset') return 'preset';
  if (part === 'history') return 'history';
  return 'card';
}

export interface AssembledMessage {
  role: PromptRole;
  content: string;
  tokens: number;
  /** 追溯:这条消息由哪个块产生 */
  sourceIdentifier: string;
  sourceName: string;
  sourceKind: 'preset' | 'marker' | 'history' | 'examples';
  /** token 分账口径 */
  part: PromptPart;
  /** 仅历史消息有 —— 指向 input.history 的下标,截断线靠它定位 */
  historyIndex?: number;
}

export interface SkippedBlock {
  identifier: string;
  name: string;
  reason: '编排里关闭' | '块内容为空' | '块不存在于预设' | '超出 token 预算' | '全部被注释';
}

/** 各 part 各占多少 token —— 预算条展开后的明细就是这个 */
export type PartTokens = Record<PromptPart, number>;

export interface BudgetReport {
  /** null = 不截断 */
  limit: number | null;
  /** 固定开销 = 除历史外的一切。预算条上那条「线」的位置 */
  fixedTokens: number;
  presetTokens: number;
  cardTokens: number;
  /** 真正进了提示词的历史(截断之后) */
  historyTokens: number;
  parts: PartTokens;
  droppedCount: number;
  droppedTokens: number;
  /** 固定开销自己就超预算了 —— 历史一条都放不下 */
  overflow: boolean;
  /** 为了不发空请求强留的最后一条,自己就超预算 */
  forcedLastMessage: boolean;
  /**
   * 第一条留下来的历史消息在 input.history 里的下标。聊天区的截断线画在它上面。
   * 历史为空时是 null。
   */
  firstKeptHistoryIndex: number | null;
}

export interface AssemblyResult {
  messages: AssembledMessage[];
  skipped: SkippedBlock[];
  totalTokens: number;
  /** 编排里引用了但 prompts 里找不到的 identifier */
  danglingIdentifiers: string[];
  budget: BudgetReport;
}

export interface AssembleInput {
  card: TavernCard;
  preset: TavernPreset;
  order: PresetOrderEntry[];
  history: ChatTurn[];
  userName: string;
  personaDescription: string;
  /** 自定义宏的查找表 —— 组装和聊天区显示用的是同一份 */
  customMacros?: Record<string, string>;
  /** 卡自带的 system_prompt / post_history_instructions 是否覆盖预设块 */
  allowCardOverrides: boolean;
  /** 整个提示词的 token 上限。超出的旧历史不进提示词。null = 不截断 */
  tokenBudget: number | null;
}

/** 示例对话按 <START> 切块,每块里 {{char}}: / {{user}}: 前缀决定 role */
function parseExampleDialogue(
  raw: string,
  ctx: MacroContext,
  newChatPrompt: string,
): AssembledMessage[] {
  if (!raw.trim()) return [];

  const out: AssembledMessage[] = [];
  const blocks = raw
    .split(/<START>/i)
    .map((b) => b.trim())
    .filter(Boolean);

  const push = (role: PromptRole, content: string) => {
    const text = substituteMacros(content.trim(), ctx);
    if (text) {
      out.push({
        role,
        content: text,
        tokens: estimateTokens(text),
        sourceIdentifier: 'dialogueExamples',
        sourceName: '示例对话',
        sourceKind: 'examples',
        part: 'examples',
      });
    }
  };

  for (const block of blocks) {
    push('system', newChatPrompt);

    // 按 "名字:" 行切分。用 {{char}}/{{user}} 或替换后的真实名字都认。
    const speakerRe = new RegExp(
      String.raw`^\s*(\{\{char\}\}|\{\{user\}\}|${escapeRe(ctx.char)}|${escapeRe(ctx.user)})\s*:`,
      'i',
    );

    let currentRole: PromptRole | null = null;
    let buffer: string[] = [];

    const flush = () => {
      if (currentRole && buffer.length) push(currentRole, buffer.join('\n'));
      buffer = [];
    };

    for (const line of block.split('\n')) {
      const m = speakerRe.exec(line);
      if (m) {
        flush();
        const who = m[1].toLowerCase();
        currentRole =
          who === '{{user}}' || who === ctx.user.toLowerCase() ? 'user' : 'assistant';
        buffer.push(line.slice(m[0].length));
      } else if (currentRole) {
        buffer.push(line);
      }
    }
    flush();
  }
  return out;
}

function escapeRe(s: string): string {
  return s ? s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\u0000nomatch';
}

/** 世界书:demo 阶段不做关键词激活,只把 enabled 的条目按顺序拼进去 */
function renderWorldInfo(card: TavernCard, wiFormat: string, ctx: MacroContext): string {
  const entries = card.character_book?.entries.filter((e) => e.enabled) ?? [];
  if (entries.length === 0) return '';
  const body = [...entries]
    .sort((a, b) => a.insertion_order - b.insertion_order)
    .map((e) => e.content)
    .filter(Boolean)
    .join('\n');
  if (!body) return '';
  return substituteMacros(wiFormat.replace('{0}', body), ctx);
}

export function assemble(input: AssembleInput): AssemblyResult {
  const {
    card,
    preset,
    order,
    history,
    userName,
    personaDescription,
    customMacros,
    allowCardOverrides,
    tokenBudget,
  } = input;

  // 不传 seed:每次发送本来就该重掷骰子。聊天区显示那边才需要定种子
  const ctx = buildMacroContext({
    card,
    userName,
    personaDescription,
    history,
    custom: customMacros,
  });

  const byIdentifier = new Map(preset.prompts.map((p) => [p.identifier, p]));
  const messages: AssembledMessage[] = [];
  const skipped: SkippedBlock[] = [];
  const dangling: string[] = [];

  const emit = (
    role: PromptRole,
    content: string,
    prompt: PresetPrompt,
    kind: AssembledMessage['sourceKind'],
    part: PromptPart,
  ) => {
    const text = content.trim();
    if (!text) {
      skipped.push({ identifier: prompt.identifier, name: prompt.name, reason: '块内容为空' });
      return;
    }
    messages.push({
      role,
      content: text,
      tokens: estimateTokens(text),
      sourceIdentifier: prompt.identifier,
      sourceName: prompt.name,
      sourceKind: kind,
      part,
    });
  };

  for (const entry of order) {
    const prompt = byIdentifier.get(entry.identifier);
    if (!prompt) {
      dangling.push(entry.identifier);
      skipped.push({
        identifier: entry.identifier,
        name: '(预设里没有这个块)',
        reason: '块不存在于预设',
      });
      continue;
    }
    if (!entry.enabled) {
      skipped.push({ identifier: prompt.identifier, name: prompt.name, reason: '编排里关闭' });
      continue;
    }

    if (!prompt.marker) {
      // 行首 // 的注释行不进请求。剔除放在宏替换**之前** ——
      // 注释掉的 {{char}} 不该被算进「未解析宏」
      const stripped = stripComments(prompt.content);
      // 整块被注释光:给个专属原因,别混进「块内容为空」——
      // 这两种情况用户要做的事完全不同
      if (prompt.content.trim() && !stripped.trim()) {
        skipped.push({
          identifier: prompt.identifier,
          name: prompt.name,
          reason: '全部被注释',
        });
        continue;
      }

      // 卡自带的 system_prompt / post_history_instructions 覆盖对应预设块。
      // 覆盖进来的字不剔注释 —— 注释是预设编辑器的功能,卡的字段归卡编辑器管
      let content = stripped;
      // 覆盖发生时账要算到卡头上 —— sourceKind 仍是 preset(它占着预设块的位置),
      // 但预算条上这几百 token 染成预设色就是骗人
      let part: PromptPart = 'preset';
      if (allowCardOverrides && !prompt.forbidOverrides) {
        if (prompt.identifier === 'main' && card.system_prompt.trim()) {
          content = card.system_prompt;
          part = 'card';
        } else if (
          prompt.identifier === 'jailbreak' &&
          card.post_history_instructions.trim()
        ) {
          content = card.post_history_instructions;
          part = 'card';
        }
      }
      emit(prompt.role, substituteMacros(content, ctx), prompt, 'preset', part);
      continue;
    }

    // ---- marker 展开 ----
    switch (prompt.identifier) {
      case 'charDescription':
        emit('system', substituteMacros(card.description, ctx), prompt, 'marker', 'card');
        break;

      case 'charPersonality':
        emit(
          'system',
          card.personality.trim()
            ? substituteMacros(preset.formats.personality_format, ctx)
            : '',
          prompt,
          'marker',
          'card',
        );
        break;

      case 'scenario':
        emit(
          'system',
          card.scenario.trim() ? substituteMacros(preset.formats.scenario_format, ctx) : '',
          prompt,
          'marker',
          'card',
        );
        break;

      case 'personaDescription':
        emit('system', substituteMacros(personaDescription, ctx), prompt, 'marker', 'persona');
        break;

      case 'worldInfoBefore':
      case 'worldInfoAfter':
        emit('system', renderWorldInfo(card, preset.formats.wi_format, ctx), prompt, 'marker', 'worldInfo');
        break;

      case 'dialogueExamples': {
        const examples = parseExampleDialogue(
          card.mes_example,
          ctx,
          preset.formats.new_example_chat_prompt,
        );
        if (examples.length === 0) {
          skipped.push({
            identifier: prompt.identifier,
            name: prompt.name,
            reason: '块内容为空',
          });
        }
        messages.push(...examples);
        break;
      }

      case 'chatHistory': {
        if (history.length === 0) {
          skipped.push({
            identifier: prompt.identifier,
            name: prompt.name,
            reason: '块内容为空',
          });
          break;
        }
        for (const [i, turn] of history.entries()) {
          const text = substituteMacros(turn.content, ctx).trim();
          if (!text) continue;
          messages.push({
            role: turn.role,
            content: text,
            tokens: estimateTokens(text),
            sourceIdentifier: 'chatHistory',
            sourceName: '对话历史',
            sourceKind: 'history',
            part: 'history',
            historyIndex: i,
          });
        }
        break;
      }

      default:
        // 预设自定义的 marker,酒馆里也是空的
        skipped.push({
          identifier: prompt.identifier,
          name: `${prompt.name} (未知 marker)`,
          reason: '块内容为空',
        });
    }
  }

  // ---- token 预算:超出的旧历史整条丢 ----
  // 刻意跑在 squash 之前:合并相邻 system 会把预设块和卡的块并成一条,
  // 分账就没法算了。squash 之后 totalTokens 和明细之和会差每次合并约 1
  // token(多一个换行 + 取整),量级可忽略,不补。
  const parts: PartTokens = {
    preset: 0,
    card: 0,
    persona: 0,
    examples: 0,
    worldInfo: 0,
    history: 0,
  };
  for (const m of messages) parts[m.part] += m.tokens;
  const fixedTokens =
    parts.preset + parts.card + parts.persona + parts.examples + parts.worldInfo;

  const budget: BudgetReport = {
    limit: tokenBudget,
    fixedTokens,
    presetTokens: parts.preset,
    cardTokens: parts.card + parts.persona + parts.examples + parts.worldInfo,
    historyTokens: parts.history,
    parts,
    droppedCount: 0,
    droppedTokens: 0,
    overflow: tokenBudget !== null && fixedTokens > tokenBudget,
    forcedLastMessage: false,
    firstKeptHistoryIndex: null,
  };

  let surviving = messages;
  if (tokenBudget !== null) {
    const allowance = tokenBudget - fixedTokens;
    const kept = new Set<number>();
    let used = 0;
    // 从最新往回留:留不下的那条以及比它更老的全部丢弃 —— 绝不切半条,
    // 也不做「跳过大条留小条」那种把对话剪成碎片的事
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const m = messages[mi];
      if (m.part !== 'history') continue;
      if (kept.size === 0) {
        // 最新一条历史必留:丢掉它等于发一个没有用户输入的请求
        kept.add(mi);
        used += m.tokens;
        if (m.tokens > allowance) budget.forcedLastMessage = true;
        budget.firstKeptHistoryIndex = m.historyIndex ?? null;
        continue;
      }
      if (used + m.tokens > allowance) break;
      kept.add(mi);
      used += m.tokens;
      budget.firstKeptHistoryIndex = m.historyIndex ?? null;
    }

    const dropped = messages.filter((m, mi) => m.part === 'history' && !kept.has(mi));
    if (dropped.length > 0) {
      budget.droppedCount = dropped.length;
      budget.droppedTokens = dropped.reduce((sum, m) => sum + m.tokens, 0);
      budget.historyTokens = used;
      skipped.push({
        identifier: 'chatHistory',
        name: `对话历史(最早的 ${dropped.length} 条)`,
        reason: '超出 token 预算',
      });
      surviving = messages.filter((m, mi) => m.part !== 'history' || kept.has(mi));
    }
  }

  const finalMessages = preset.squashSystemMessages ? squashSystem(surviving) : surviving;

  return {
    messages: finalMessages,
    skipped,
    totalTokens: finalMessages.reduce((sum, m) => sum + m.tokens, 0),
    danglingIdentifiers: dangling,
    budget,
  };
}

/** 合并相邻的 system 消息(酒馆的 squash_system_messages) */
function squashSystem(messages: AssembledMessage[]): AssembledMessage[] {
  const out: AssembledMessage[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (m.role === 'system' && prev?.role === 'system') {
      const content = `${prev.content}\n${m.content}`;
      out[out.length - 1] = {
        ...prev,
        content,
        tokens: estimateTokens(content),
        sourceName: `${prev.sourceName} + ${m.sourceName}`,
        sourceIdentifier: `${prev.sourceIdentifier},${m.sourceIdentifier}`,
      };
    } else {
      out.push(m);
    }
  }
  return out;
}

export function markerLabel(identifier: string, fallback: string): string {
  return MARKER_LABELS[identifier] ?? fallback;
}
