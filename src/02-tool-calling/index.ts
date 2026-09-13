/**
 * 第 2 课：Tool Calling（函数调用）
 *
 * 核心认知：模型**不能**真正执行你的代码。所谓"调用工具"是这样一套协议：
 *
 *   1. 你在请求里告诉模型："有哪些工具可用、各自干什么、参数是什么"
 *   2. 模型判断后不直接回答，而是返回一个 tool_calls ——
 *      "请帮我执行 get_weather，参数是 { city: '北京' }"
 *   3. **你**在自己的代码里真正执行这个函数
 *   4. 把执行结果作为一条 role: 'tool' 的消息发回给模型
 *   5. 模型结合工具结果，生成最终的自然语言回答
 *
 * 注意第 3 步：执行者是你，不是模型。模型只负责"点菜"。
 */

export {}

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

type Role = 'system' | 'user' | 'assistant' | 'tool'

interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCall[] // 只有 assistant 发起工具调用时才有
  tool_call_id?: string // 只有 role: 'tool' 时才有
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    // 注意：arguments 是 JSON **字符串**，不是对象！需要自己 JSON.parse
    arguments: string
  }
}

// ---------- 第 1 步：用 JSON Schema 描述你的工具 ----------

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的实时天气',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，如：北京' },
        },
        required: ['city'],
      },
    },
  },
]

// ---------- 真正的工具实现（就在你的 Node 进程里跑） ----------

function getWeather(args: { city: string }): string {
  // 这里 mock 一下，实际可以是调高德/和风天气 API
  const data: Record<string, string> = {
    北京: '晴，26°C，空气质量优',
    上海: '小雨，22°C，湿度 85%',
  }
  return JSON.stringify({ city: args.city, weather: data[args.city] ?? '暂无数据' })
}

// ---------- 调 API 的通用封装 ----------

async function chat(messages: Message[]) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools, // ← 与第 1 课唯一的请求差异
    }),
  })
  if (!res.ok) throw new Error(`API 错误 ${res.status}: ${await res.text()}`)
  return await res.json()
}

// ---------- 场景演示 ----------

// 场景 A：用户问的问题需要工具
console.log('====== 场景 A：需要调用工具 ======\n')

const messagesA: Message[] = [
  { role: 'user', content: '北京今天天气怎么样？适合跑步吗？' },
]

// 第 1 次请求：模型返回的不是 content，而是 tool_calls
const resA1 = await chat(messagesA)
const assistantMsg = resA1.choices[0].message

console.log('模型返回的原始消息（注意没有 content，只有 tool_calls）：')
console.dir(assistantMsg, { depth: null })

// 把模型"点菜"的这条消息原样加入历史（协议要求，第 4 步回传结果时模型靠它对账）
messagesA.push(assistantMsg)

// 第 2 步：你来执行工具
const toolCall: ToolCall = assistantMsg.tool_calls[0]
const args = JSON.parse(toolCall.function.arguments) // 记得 parse！
const result = getWeather(args)

console.log(`\n执行工具 ${toolCall.function.name}(${JSON.stringify(args)}) → ${result}\n`)

// 第 3 步：把执行结果以 role: 'tool' 发回去，tool_call_id 必须对上
messagesA.push({
  role: 'tool',
  tool_call_id: toolCall.id,
  content: result,
})

// 第 4 次请求：模型拿到工具结果，生成最终回答
const resA2 = await chat(messagesA)
console.log('模型最终回答：')
console.log(resA2.choices[0].message.content)

// 场景 B：不需要工具的问题，模型会直接回答，不会硬调工具
console.log('\n====== 场景 B：不需要工具，模型直接回答 ======\n')

const messagesB: Message[] = [{ role: 'user', content: '你好，你叫什么名字？' }]
const resB = await chat(messagesB)
console.dir(resB.choices[0].message, { depth: null })
console.log('模型最终回答：')
console.log(resB.choices[0].message.content)
