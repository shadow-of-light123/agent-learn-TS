/**
 * 第 3 课：Agent Loop —— 所有 Agent 框架的核心引擎
 *
 * 第 2 课的流程只走一轮：模型点菜 → 你执行 → 模型总结，就结束了。
 * 但真实任务是多步的："对比北京和上海的天气"需要查两次天气、再算温差。
 *
 * 解决方案出奇地简单 —— 一个 while 循环：
 *
 *   while (true) {
 *     调模型（带上全部对话历史 + 工具清单）
 *     ├─ 模型返回 tool_calls → 你逐个执行，结果追加进历史，continue
 *     └─ 模型返回普通回答   → 循环结束，任务完成
 *   }
 *
 * 「何时继续、何时收工」由模型自己决定 —— 这就是"自主决策"的全部含义。
 * 你接下来写的这 100 行，就是 LangChain / Vercel AI SDK 里 agent 引擎的雏形。
 *
 * ── 本课的加固：用 zod 校验模型给的参数 ──
 *
 * 模型的 arguments 是从网络过来的、不可信的字符串。TypeScript 的类型编译后就没了，
 * 管不住它。zod schema 是真实存在的对象，运行时能真的去检查，而且一份定义同时产出：
 *
 *   ① 发给模型的 JSON Schema（z.toJSONSchema）
 *   ② 运行时校验器（safeParse）
 *   ③ execute 参数的类型（z.infer）
 *
 * 出错不再静默 —— 校验失败会把原因回传给模型，它能看懂并自己改对重试。
 */

import { z } from 'zod'

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

// ---------- 工具注册表：定义 + 实现写在一起，单一数据源 ----------

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

const toolRegistry = {
  get_weather: defineTool({
    description: '查询指定城市的实时天气',
    argsSchema: z.object({
      city: z.string().min(1).describe('城市名，如 北京'),
    }),
    execute: ({ city }) => {
      const data: Record<string, string> = {
        北京: '晴，12°C，空气质量优，风力 3 级',
        上海: '多云，18°C，空气质量良，湿度 80%',
      }
      return JSON.stringify({ city, weather: data[city] ?? '暂无数据' })
    },
  }),

  calculate: defineTool({
    description: '计算一个数学表达式，返回数值结果',
    argsSchema: z.object({
      // 模型输出不可信，先用字符白名单卡住，别让任意 JS 进 new Function
      expression: z
        .string()
        .regex(/^[0-9+\-*/().\s]+$/, '只允许由数字和 + - * / ( ) 组成的算式')
        .describe('数学表达式，如 (12-18)*1.8'),
    }),
    execute: ({ expression }) => {
      // 前面的正则已经卡住字符集，这里只是求值；生产环境仍建议换成 expr-eval 之类的解析器
      const value = new Function(`return (${expression})`)()
      return JSON.stringify({ expression, value })
    },
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
  function: {
    name,
    description: t.description,
    parameters: toToolSchema(t.argsSchema),
  },
}))

// ---------- 通用的工具执行器：不管是什么工具，统一这一套流程 ----------

function executeTool(toolCall: { id: string; function: { name: string; arguments: string } }): string {
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

  // 第二关：用 schema 卡住结构和类型 —— 这一步 TypeScript 类型做不到，只有运行时才拦得住
  const parsed = tool.argsSchema.safeParse(raw)
  if (!parsed.success) {
    // 不抛异常，而是把失败原因回传给模型 —— 它看到具体哪里错了就能自己改对重试
    return JSON.stringify({ error: `参数校验失败: ${parsed.error.message}` })
  }

  try {
    // parsed.data 是校验通过的数据，往下可以放心用
    return tool.execute(parsed.data)
  } catch (e) {
    // 工具本身执行时炸了，同样交给模型决定怎么办
    return JSON.stringify({ error: String(e) })
  }
}

// ---------- 核心：Agent Loop ----------

const MAX_ITERATIONS = 10 // 保险丝：防止模型陷入"无限点菜"烧钱

async function agent(question: string): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: '你是一个严谨的助手，回答简洁。' },
    { role: 'user', content: question },
  ]

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, messages, tools: toolDefs }),
    })
    if (!res.ok) throw new Error(`API 错误 ${res.status}: ${await res.text()}`)

    const msg = (await res.json()).choices[0].message

    // ★ 出口：模型认为信息够了，直接给出最终回答，循环结束
    if (!msg.tool_calls?.length) {
      console.log(`[第 ${i} 轮] 模型给出最终回答，循环结束\n`)
      return msg.content
    }

    console.log(`[第 ${i} 轮] 模型请求调用工具: ${msg.tool_calls.map((c: any) => c.function.name).join(', ')}`)

    // ★ 未出口：先记录模型的"点菜"，再逐个执行，把结果喂回去
    messages.push(msg)
    for (const toolCall of msg.tool_calls) {
      const result = executeTool(toolCall)
      console.log(`          ↳ ${toolCall.function.name}(${toolCall.function.arguments}) → ${result}`)
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }

  throw new Error(`超过最大轮数 ${MAX_ITERATIONS}，强制终止`)
}

// ---------- 运行 ----------

const answer = await agent(
  '查一下北京和上海现在的天气，哪个城市更适合跑步？两地温差是多少摄氏度？请用计算工具算温差。',
)
console.log('====== Agent 最终回答 ======')
console.log(answer)
