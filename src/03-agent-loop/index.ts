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
 */

export {}

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

interface Tool {
  description: string
  parameters: Record<string, unknown> // JSON Schema
  execute: (args: any) => string
}

const toolRegistry: Record<string, Tool> = {
  get_weather: {
    description: '查询指定城市的实时天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
    execute: ({ city }: { city: string }) => {
      const data: Record<string, string> = {
        北京: '晴，12°C，空气质量优，风力 3 级',
        上海: '多云，18°C，空气质量良，湿度 80%',
      }
      return JSON.stringify({ city, weather: data[city] ?? '暂无数据' })
    },
  },
  calculate: {
    description: '计算一个数学表达式，返回数值结果',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '数学表达式，如 (12-18)*1.8' } },
      required: ['expression'],
    },
    execute: ({ expression }: { expression: string }) => {
      // 教学演示用 Function 求值，生产环境请用 expr-eval 等库并做输入校验
      const value = new Function(`return (${expression})`)()
      return JSON.stringify({ expression, value })
    },
  },
  get_current_time: {
    description: '获取当前日期和时间',
    parameters: { type: 'object', properties: {} },
    execute: () => JSON.stringify({ now: new Date().toLocaleString('zh-CN') }),
  },
}

// 从注册表自动生成 API 需要的工具清单（改一处，两边同步 —— 和你封装的配置驱动表格是同一个思想）
const toolDefs = Object.entries(toolRegistry).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: t.parameters },
}))

// ---------- 通用的工具执行器：不管是什么工具，统一这一套流程 ----------

function executeTool(toolCall: { id: string; function: { name: string; arguments: string } }): string {
  const tool = toolRegistry[toolCall.function.name]
  if (!tool) {
    return JSON.stringify({ error: `未知工具: ${toolCall.function.name}` })
  }
  try {
    return tool.execute(JSON.parse(toolCall.function.arguments))
  } catch (e) {
    // 把错误信息返回给模型而不是直接崩溃 —— 模型看到错误可以自己调整重试
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
