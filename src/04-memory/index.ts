/**
 * 第 4 课：Memory（记忆）
 *
 * 第 3 课的 Agent 是"金鱼"—— 每次 npm run 都从零开始。原因：
 * 模型本身无状态，所谓"记忆"就是把历史消息每次全部重发一遍。
 * 这带来两个工程问题：
 *
 *   1. 多轮对话：需要把历史消息在内存/数据库里维护起来（本课用 REPL 演示）
 *   2. 上下文膨胀：历史越长，每次请求越贵，最终撑爆上下文窗口
 *      → 需要压缩策略（本课实现「摘要压缩」，Claude Code 的 /compact 同款思路）
 *
 * 本课会在三个地方踩坑，注释里都标了 ★：
 *
 *   ★ 坑 1（配对）：裁剪历史时，assistant 的 tool_calls 和对应的 role:'tool' 结果
 *     必须成对保留，拆散了 API 直接报 400。
 *     → 解法：压缩只在 user 消息的边界切割，user 永远是新话题的起点。
 *
 *   ★ 坑 2（压不动）：一次压缩不一定够。如果"想保留的最近几条"本身就超预算，
 *     压完还是超 —— 所以要分档压缩，而且要能识别"已经压无可压"，
 *     否则每一轮都白送一次摘要调用的钱。
 *     → 解法：两档压缩（先保原文，再只保当前这一轮）+ 压缩必须真的变小。
 *
 *   ★ 坑 3（工具结果）：工具结果直接进上下文，而且刚拿到的结果就在"保留区"里，
 *     压缩保护不到它。一个返回 10 万字的工具能让预算形同虚设。
 *     → 解法：工具结果单独设长度上限（MAX_TOOL_RESULT_CHARS）。
 *
 * 工具的写法跟第 3 课保持一致：zod 单一数据源（JSON Schema + 运行时校验 + TS 类型）。
 *
 * 想强制看到压缩发生（预算调小即可）：
 *   TOKEN_BUDGET=300 npm run l4
 *   TOKEN_BUDGET=300 npm run l4:test   # 用 test-input.txt 跑非交互流程
 */

import readline from 'node:readline/promises'
import { z } from 'zod'

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

type Role = 'system' | 'user' | 'assistant' | 'tool'

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    // 注意：arguments 是 JSON **字符串**，不是对象，需要自己 JSON.parse（且不可信）
    arguments: string
  }
}

interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCall[] // 只有 assistant 发起工具调用时才有
  tool_call_id?: string // 只有 role: 'tool' 时才有
}

// 模型返回的 message 就是这个形状。单独写出来，是为了让 callModel 有个明确的返回类型 ——
// 否则一路 any 到底，msg.tool_calls 写错名字编译器都不会提醒你
type AssistantMessage = Omit<Message, 'role'> & { role: 'assistant' }

// ---------- 工具（复用第 3 课的 zod 注册表：定义 + 校验 + 实现写在一起） ----------

interface Tool<S extends z.ZodType> {
  description: string
  argsSchema: S // 既是给模型看的 JSON Schema 来源，也是运行时校验器
  execute: (args: z.infer<S>) => string
}

// 查找时用的宽松视图：工具名要运行时才知道，参数在 executeTool 里已经校验过了
type AnyTool = Tool<any>

// 这个小函数的作用是让 TS 把 argsSchema 和 execute 的参数连起来 ——
// 有了它，下面 execute 里的解构不用手写类型，改 schema 会自动跟着变
function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool
}

// 记事本：故意放在消息历史之外。
// 这样即使对话历史被摘要压缩掉了，记事本里的内容依然一字不差 ——
// "会话记忆"和"长期事实"本来就是两件事，很多人第一次做 Agent 会把它们混在一个数组里。
const notes: string[] = []

const toolRegistry = {
  save_note: defineTool({
    description: '把一条重要信息保存到记事本，供以后回忆',
    argsSchema: z.object({
      note: z.string().min(1).describe('要记住的内容'),
    }),
    execute: ({ note }) => {
      notes.push(note)
      return JSON.stringify({ saved: note, total: notes.length })
    },
  }),

  list_notes: defineTool({
    description: '查看记事本里的所有内容',
    argsSchema: z.object({}),
    execute: () => JSON.stringify({ notes }),
  }),

  get_current_time: defineTool({
    description: '获取当前日期和时间',
    argsSchema: z.object({}),
    execute: () => JSON.stringify({ now: new Date().toLocaleString('zh-CN') }),
  }),
}

const registry: Record<string, AnyTool> = toolRegistry

// 从注册表自动生成 API 需要的工具清单 —— JSON Schema 交给 zod 生成，不再手写
function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  // 去掉 $schema 字段：模型 API 只关心结构本身，多带这个字段有些供应商会不认
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

const toolDefs = Object.entries(toolRegistry).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: toToolSchema(t.argsSchema) },
}))

// ---------- 通用请求 ----------

// 把 withTools 抽成参数，是因为生成摘要时不能带工具：
// 带上工具，模型可能又去"点菜"，摘要任务就完成不了
async function callModel(messages: Message[], withTools = true): Promise<AssistantMessage> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(withTools ? { tools: toolDefs } : {}),
    }),
  })
  if (!res.ok) throw new Error(`API 错误 ${res.status}: ${await res.text()}`)

  // res.json() 出来是 any（网络来的数据，编译器管不着）。
  // 信任边界就划在这一行：在这里一次性收窄成我们约定的形状，
  // 后面的代码就能享受类型检查了（结构本身仍是"信任但标注"，要严格校验得再上 zod）
  const data = (await res.json()) as { choices: { message: AssistantMessage }[] }
  return data.choices[0].message
}

// ---------- 工具执行：模型给的参数一律当作不可信输入 ----------

// ★ 坑 3：工具结果直接进上下文，而"刚拿到的结果"就在保留区里，压缩保护不到它。
// 所以必须在这里设上限 —— 这是生产 Agent 的标配（Claude Code 也用类似方式截断工具输出）
const MAX_TOOL_RESULT_CHARS = 2000

function clipToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result
  // 截断了要如实告诉模型，否则它会以为拿到的是完整数据，基于残数据继续推理
  return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n…【工具结果过长已截断：原始 ${result.length} 字符】`
}

function executeTool(toolCall: ToolCall): string {
  const tool = registry[toolCall.function.name]
  if (!tool) {
    return JSON.stringify({ error: `未知工具: ${toolCall.function.name}` })
  }

  // 第一关：模型的 arguments 是一段文本，先确认它是合法 JSON
  let raw: unknown
  try {
    raw = JSON.parse(toolCall.function.arguments)
  } catch {
    return JSON.stringify({ error: `参数不是合法 JSON: ${toolCall.function.arguments}` })
  }

  // 第二关：用 schema 卡住结构和类型 —— TypeScript 的类型编译后就没了，只有运行时拦得住
  const parsed = tool.argsSchema.safeParse(raw)
  if (!parsed.success) {
    // 不抛异常，而是把失败原因回传给模型 —— 它看到具体哪里错了就能自己改对重试
    return JSON.stringify({ error: `参数校验失败: ${parsed.error.message}` })
  }

  try {
    return clipToolResult(tool.execute(parsed.data))
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ---------- Memory 核心 1：token 估算 ----------
// 精确 tokenization 需要 tokenizer（如 tiktoken），这里用粗略启发式：
// 中文约 1 字 ≈ 0.5~0.6 token，再算上 JSON 结构开销，整个 JSON 除以 2 足够演示用。
// 注意它是"估算"不是"计费"—— 只要它和真实值同向变化，压缩策略就能正常工作。

// 只取出真正会发给 API 的字段。
// 两个用处：① 让 token 估算更接近真实（API 返回的 message 可能还带着
// reasoning_content 这类思考过程字段，服务端下一轮会忽略它，留着白占预算）
// ② 生成摘要时喂给模型的原历史里也不该塞思考过程
function toApiView(messages: Message[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }))
}

function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(toApiView(messages)).length / 2)
}

// ---------- Memory 核心 2：摘要压缩（compaction） ----------

// demo 故意用一个很小的预算，几轮对话就能看到压缩；真实模型窗口是 64K 起步
const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET ?? 1800)
const KEEP_RECENT = 6 // 第一档：压缩后尽量保留最近 N 条原始消息
const COMPACT_TIERS = [KEEP_RECENT, 0] // 第二档保留 0 条 = 只留"当前这一轮"

/**
 * 找一个合法的切割点，返回下标 cut，含义是：
 *   messages[1 .. cut)  拿去摘要
 *   messages[cut ..]    原样保留
 *
 * 一次同时满足两条硬约束：
 *   ★ 坑 1：cut 必须落在 user 消息上 —— 这样 tool_calls 和它的 tool 结果
 *     要么整组进摘要、要么整组被保留，绝不会被拆散（结果永远紧跟它的 assistant 消息）
 *   ★ 坑 2 的推论：cut 不能切进"当前这一轮"。每轮对话只追加一条 user 消息，
 *     从后往前找 user，天然就停在这轮的第一条 user 上，绝不会切到轮子中间
 *
 * @param keep 这一档想保留多少条原始消息（越大越保守）
 * @returns 找不到合法切割点时返回 -1
 */
function findCutPoint(messages: Message[], keep: number): number {
  // cut 越小保留得越多；要保留 keep 条，cut 就不能超过 length - keep
  const upper = messages.length - keep

  for (let i = Math.min(upper, messages.length - 1); i >= 2; i--) {
    if (messages[i].role !== 'user') continue

    // i === 2 时，待压缩区只剩 messages[1] 这一条。
    // 如果它正好是上一次的摘要，那"把摘要再摘要一遍"几乎没有收益，
    // 却要花一次模型调用 —— 直接放弃，这样才能避免每轮都白花钱
    if (i === 2 && messages[1].role === 'system') return -1

    return i
  }
  return -1
}

/** 把 messages[1, cut) 压成一条摘要，返回新的历史数组 */
async function summarizeBefore(messages: Message[], cut: number): Promise<Message[]> {
  const toSummarize = messages.slice(1, cut) // 跳过开头的 system 提示词
  const recent = messages.slice(cut)

  console.log(
    `\n[记忆压缩] 压缩 ${toSummarize.length} 条历史 → 1 条摘要，保留最近 ${recent.length} 条原文`,
  )

  const summary = await callModel(
    [
      {
        role: 'system',
        content:
          '请把以下对话历史压缩成一段简洁摘要，必须保留：关键事实、用户偏好、已得出的结论。直接输出摘要正文。',
      },
      { role: 'user', content: JSON.stringify(toApiView(toSummarize)) },
    ],
    false, // 不带工具，见 callModel 里的说明
  )

  const text = summary.content?.trim() || '（本次摘要生成失败，更早的历史内容已丢弃）'
  console.log(`[记忆压缩] 摘要：${text.slice(0, 120)}…`)

  return [
    messages[0], // 原 system 提示词：永远保留，永远在第一位
    { role: 'system', content: `【之前的对话摘要】\n${text}` }, // ← 记忆以摘要形式存续
    ...recent,
  ]
}

/**
 * 超预算就压缩。返回"可能被压缩过"的新历史数组。
 *
 * 为什么是两档而不是一次切到底：
 *   第一档想尽量多留原文（保留 KEEP_RECENT 条），这样模型看到的细节最多；
 *   但如果"最近这几条"本身就很长，压完还是超 —— 那就再退一档，
 *   只保留当前这一轮，把之前的一切（包括上次的摘要）都并进新摘要。
 *
 * 这是一个取舍：其实还有"保留 5 条""保留 4 条"这些中间档，找一个刚好够用的
 * 能少丢一点上下文；但每试一档就是一次模型调用，为了不让一次压缩变成十几次请求，
 * 这里只留两档 —— 最省的（尽量保原文）和最狠的（只留当前轮）。
 */
async function compactIfNeeded(messages: Message[]): Promise<Message[]> {
  if (estimateTokens(messages) <= TOKEN_BUDGET) return messages

  let history = messages

  for (const [tier, keep] of COMPACT_TIERS.entries()) {
    if (estimateTokens(history) <= TOKEN_BUDGET) return history

    const cut = findCutPoint(history, keep)
    if (cut === -1) continue // 这一档没有合法切割点，试试下一档

    const before = estimateTokens(history)
    const compacted = await summarizeBefore(history, cut)

    // ★ 关键防线：压缩必须真的变小。
    // 如果压完还一样大（甚至更大），说明已经压无可压 —— 再试就是每一轮白送一次模型调用
    if (estimateTokens(compacted) >= before) {
      console.log('[记忆压缩] 压缩后历史没有变小，停止压缩')
      break
    }

    history = compacted
    console.log(
      `[记忆压缩] 第 ${tier + 1} 档完成：${before} → ${estimateTokens(history)} tokens（预算 ${TOKEN_BUDGET}）`,
    )
  }

  if (estimateTokens(history) > TOKEN_BUDGET) {
    // 走到这里说明预算没压下来，通常是两种情况：
    //   · 已经压到只剩当前这一轮，而"这一轮"自己就超预算（比如用户粘贴了长文档）
    //   · 可压缩的只剩上一次的摘要，再摘要也不会变小
    // 无论哪种，继续压都只能丢掉用户正在问的内容 —— 所以如实告知，不再花冤枉钱
    console.log(
      `[记忆压缩] ⚠️  仍有 ${estimateTokens(history)} tokens > 预算 ${TOKEN_BUDGET}，已无可压缩空间，不再尝试压缩`,
    )
  }
  return history
}

// ---------- 带"记忆"的 Agent ----------

const SYSTEM_PROMPT =
  '你是一个长期助手，拥有记事本工具。遇到用户偏好、重要约定等值得长期记住的信息时，主动调用 save_note 保存。回答简洁。'

const MAX_ITERATIONS = 10 // 保险丝：防止模型陷入"无限点菜"烧钱

class MemoryAgent {
  // ★ 这个数组就是"记忆"的全部。进程一退，它就没了 —— 所以下一课是持久化。
  private messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  async chat(question: string): Promise<string> {
    this.messages.push({ role: 'user', content: question })

    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      // ★ 每次调模型前检查预算。压缩只动"当前这一轮之前"的历史，
      // 所以它可以在工具循环中间安全发生，不会拆散正在进行的 tool_calls
      this.messages = await compactIfNeeded(this.messages)

      const msg = await callModel(this.messages)
      this.messages.push(msg) // assistant 的消息（无论是回答还是点菜）都要进历史

      // ★ 出口：模型没有点菜 = 给出最终回答
      if (!msg.tool_calls?.length) {
        console.log(
          `[本轮] 第 ${i} 次调用后收工，历史 ${estimateTokens(this.messages)} tokens / ${this.messages.length} 条消息`,
        )
        return msg.content ?? '' // content 可能是 null（模型只点菜不说话），兜个底
      }

      console.log(`[第 ${i} 轮] 模型请求调用工具: ${msg.tool_calls.map((c) => c.function.name).join(', ')}`)

      // ★ 先把点菜记进历史，再逐个执行、把结果喂回去（顺序错了 API 会报 400）
      for (const toolCall of msg.tool_calls) {
        const result = executeTool(toolCall)
        console.log(`          ↳ ${toolCall.function.name}(${toolCall.function.arguments}) → ${result}`)
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
      }
    }
    throw new Error(`超过最大轮数 ${MAX_ITERATIONS}，强制终止`)
  }
}

// ---------- 交互式 REPL：现在它记得住你说过的话了 ----------

const agent = new MemoryAgent()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const IS_TTY = process.stdout.isTTY === true // 管道模式下不打印提示符，免得混进输出

// 自己维护一个行队列，而不是直接用 rl.question：
// 当 stdin 是管道时，输入很快 EOF，readline 会 close 并丢弃缓冲行；
// 事件队列方式在交互(TTY)和管道两种模式下行为一致
const lineQueue: string[] = []
let pendingResolve: ((line: string) => void) | null = null
let inputClosed = false // ★ 记下"输入已经结束"，否则这个信号会丢

rl.on('line', (line) => {
  if (pendingResolve) {
    const resolve = pendingResolve
    pendingResolve = null
    resolve(line)
  } else {
    lineQueue.push(line)
  }
})

rl.on('close', () => {
  // ★ 这里有两个坑：
  //   1. close 只触发一次 —— 闹钟一响就必须立刻响（正在等待就 resolve）
  //   2. 但如果此刻主循环正忙着调模型（pendingResolve 为空），这次唤醒就落空了：
  //      等到下一次 ask() 又会挂起，而 close 不会再来第二次 → 进程永远卡住。
  //      所以要把"已关闭"这个状态记下来，让后面的 ask() 自己就能立刻返回
  inputClosed = true
  pendingResolve?.('exit') // 输入流结束 = 退出
  pendingResolve = null
})

function ask(): Promise<string> {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!) // 缓冲里的真实输入优先
  if (inputClosed) return Promise.resolve('exit') // 输入已结束，别再挂起等待
  return new Promise((resolve) => (pendingResolve = resolve))
}

console.log('带记忆的 Agent 已启动（输入 exit 退出）。试试先自我介绍，再问"我叫什么名字？"')
while (true) {
  if (IS_TTY) process.stdout.write('\n你> ')
  const question = await ask()
  if (!question.trim()) continue
  if (['exit', 'quit', '退出'].includes(question.trim())) break
  console.log(`Agent> ${await agent.chat(question)}`)
}
rl.close()
console.log('\n会话结束。注意：刷新页面后记忆就没了 —— 下一步就是持久化（存数据库），以及外挂长期记忆（RAG）。')
