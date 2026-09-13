/**
 * 第 1 课 · Part 1：裸调 LLM 的 Chat API（非流式）
 *
 * 核心认知：所谓"调用大模型"，本质就是一个普通的 HTTP POST 请求。
 * 没有任何魔法 —— 你发一段消息数组，它返回一段文本。
 *
 * 我们不用 openai 官方 SDK，就用原生 fetch，看清楚每一个字段。
 */

// 让 TS 把本文件识别为独立模块（有 import/export 的文件拥有自己的作用域）
export { }

// DeepSeek 的接口是 OpenAI 兼容格式，这个结构会贯穿整个课程
type Role = 'system' | 'user' | 'assistant'

interface Message {
  role: Role
  content: string
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

if (!API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY，请在 .env 文件中配置')
  process.exit(1)
}

async function chat(messages: Message[]): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`API 错误 ${res.status}: ${err}`)
  }

  const data = await res.json()
  // 打开注释可以看完整响应结构 —— 熟悉它，后面课程会反复用到
  // console.dir(data, { depth: null })

  return data.choices[0].message.content
}

const messages: Message[] = [
  // system：设定模型的行为准则，模型会尽量在整个对话中遵守
  { role: 'system', content: '你是一位简洁的前端技术导师，回答不超过 100 字。' },
  // user：用户输入
  { role: 'user', content: '一句话解释什么是 AI Agent？' },
]

const reply = await chat(messages)
console.log('模型回复：')
console.log(reply)
