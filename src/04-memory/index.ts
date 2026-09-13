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
 * ★ 一个容易踩的坑：裁剪历史时，assistant 的 tool_calls 和对应
 *   role:'tool' 的结果必须成对保留，拆散了 API 直接报 400。
 *   所以压缩只在 user 消息的边界切割 —— user 永远是新话题的起点。
 */

export { }

import readline from 'node:readline/promises'

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

type Role = 'system' | 'user' | 'assistant' | 'tool'

interface Message {
  role: Role
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

// ---------- 工具（复用第 3 课的注册表模式，新增一个记事本工具） ----------

interface Tool {
  description: string
  parameters: Record<string, unknown>
  execute: (args: any) => string
}

const notes: string[] = []

const toolRegistry: Record<string, Tool> = {
  save_note: {
    description: '把一条重要信息保存到记事本，供以后回忆',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: '要记住的内容' } },
      required: ['note'],
    },
    execute: ({ note }: { note: string }) => {
      notes.push(note)
      return JSON.stringify({ saved: note, total: notes.length })
    },
  },
  list_notes: {
    description: '查看记事本里的所有内容',
    parameters: { type: 'object', properties: {} },
    execute: () => JSON.stringify({ notes }),
  },
  get_current_time: {
    description: '获取当前日期和时间',
    parameters: { type: 'object', properties: {} },
    execute: () => JSON.stringify({ now: new Date().toLocaleString('zh-CN') }),
  },
}

const toolDefs = Object.entries(toolRegistry).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: t.parameters },
}))

// ---------- 通用请求与工具执行 ----------

async function callModel(messages: Message[], withTools = true) {
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
  return (await res.json()).choices[0].message
}

function executeTool(toolCall: { function: { name: string; arguments: string } }): string {
  const tool = toolRegistry[toolCall.function.name]
  if (!tool) return JSON.stringify({ error: `未知工具: ${toolCall.function.name}` })
  try {
    return tool.execute(JSON.parse(toolCall.function.arguments))
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ---------- Memory 核心 1：token 估算 ----------
// 精确 tokenization 需要 tokenizer（如 tiktoken），这里用粗略启发式：
// 中文约 1 字 ≈ 0.6 token，JSON 结构开销算进去除以 2 足够演示用

function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 2)
}

// ---------- Memory 核心 2：摘要压缩（compaction） ----------

const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET ?? 1800) // 可用环境变量覆盖，方便测试压缩
const KEEP_RECENT = 6 // 压缩时至少保留最近 N 条原始消息

async function compactIfNeeded(messages: Message[]): Promise<Message[]> {
  const used = estimateTokens(messages)
  if (used <= TOKEN_BUDGET) return messages

  // 历史太短时没有安全的压缩空间（切割点会算成负数），先放行
  // 真实系统还可以在这里选择"硬截断"或直接拒绝超长输入
  if (messages.length <= KEEP_RECENT + 2) return messages

  // 找切割点：从"保留区"往前找到第一条 user 消息（保证 tool_calls/tool 结果不被拆散）
  const cut = messages.length - KEEP_RECENT
  let boundary = cut
  while (boundary > 1 && messages[boundary].role !== 'user') boundary--
  if (boundary <= 1) return messages // 整段历史都是一团工具调用，没有 user 边界可切

  const toSummarize = messages.slice(1, boundary) // 跳过 system 提示词
  const recent = messages.slice(boundary)

  console.log(`\n[记忆压缩] ${estimateTokens(messages)} tokens 超预算 ${TOKEN_BUDGET}，压缩 ${toSummarize.length} 条历史 → 1 条摘要`)

  // 用一次不带工具的模型调用生成摘要
  const summaryMsg = await callModel(
    [
      {
        role: 'system',
        content: '请把以下对话历史压缩成一段简洁摘要，必须保留：关键事实、用户偏好、已得出的结论。直接输出摘要正文。',
      },
      { role: 'user', content: JSON.stringify(toSummarize, null, 0) },
    ],
    false,
  )

  console.log(`[记忆压缩] 摘要内容：${summaryMsg.content?.slice(0, 120)}…\n`)

  return [
    messages[0], // 原 system 提示词
    { role: 'system', content: `【之前的对话摘要】\n${summaryMsg.content}` }, // ← 记忆以摘要形式存续
    ...recent,
  ]
}

// ---------- 带"记忆"的 Agent ----------

const SYSTEM_PROMPT =
  '你是一个长期助手，拥有记事本工具。遇到用户偏好、重要约定等值得长期记住的信息时，主动调用 save_note 保存。回答简洁。'

class MemoryAgent {
  private messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  async chat(question: string): Promise<string> {
    this.messages.push({ role: 'user', content: question })

    const MAX_ITERATIONS = 10
    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      this.messages = await compactIfNeeded(this.messages) // ★ 每次调模型前检查预算

      const msg = await callModel(this.messages)
      if (!msg.tool_calls?.length) {
        this.messages.push(msg)
        console.log(`[本轮] 历史约 ${estimateTokens(this.messages)} tokens / ${this.messages.length} 条消息`)
        return msg.content
      }

      this.messages.push(msg)
      for (const toolCall of msg.tool_calls) {
        const result = executeTool(toolCall)
        console.log(`[工具] ${toolCall.function.name}(${toolCall.function.arguments}) → ${result}`)
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
      }
    }
    throw new Error('超过最大轮数')
  }
}

// ---------- 交互式 REPL：现在它记得住你说过的话了 ----------

const agent = new MemoryAgent()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// 自己维护一个行队列，而不是直接用 rl.question：
// 当 stdin 是管道时，输入很快 EOF，readline 会 close 并丢弃缓冲行；
// 事件队列方式在交互(TTY)和管道两种模式下行为一致
const lineQueue: string[] = []
let pendingResolve: ((line: string) => void) | null = null

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
  pendingResolve?.('exit') // 输入流结束 = 退出
})

function ask(): Promise<string> {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!)
  return new Promise((resolve) => (pendingResolve = resolve))
}

console.log('带记忆的 Agent 已启动（输入 exit 退出）。试试先自我介绍，再问"我叫什么名字？"')
while (true) {
  process.stdout.write('\n你> ')
  const question = await ask()
  if (!question.trim()) continue
  if (['exit', 'quit', '退出'].includes(question.trim())) break
  console.log(`Agent> ${await agent.chat(question)}`)
}
rl.close()
console.log('\n会话结束。注意：刷新页面后记忆就没了 —— 下一步就是持久化（存数据库），以及外挂长期记忆（RAG）。')
