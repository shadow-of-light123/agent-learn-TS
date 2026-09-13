/**
 * 第 1 课 · Part 2：流式输出（SSE）
 *
 * 你在 AI 面试平台里用 fetch + ReadableStream 写过 SSE 流式渲染 ——
 * 这次的区别是：你以前是"消费"别人提供的事件流，现在从服务端视角看
 * 模型 API 到底吐出了什么格式的事件。
 *
 * LLM 流式的本质：模型逐 token 生成，每生成一小段，服务端就通过
 * SSE 推送一个 chunk。`stream: true` 就是打开这个开关。
 */

// 让 TS 把本文件识别为独立模块（有 import/export 的文件拥有自己的作用域）
export { }

type Role = 'system' | 'user' | 'assistant'

interface Message {
  role: Role
  content: string
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

async function chatStream(messages: Message[]): Promise<void> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true, // ← 与非流式唯一的请求差异
    }),
  })

  if (!res.ok || !res.body) {
    throw new Error(`API 错误 ${res.status}: ${await res.text()}`)
  }

  // res.body 是 Web ReadableStream，按行切分 SSE 帧
  // SSE 帧格式（和你在面试平台解析过的一样）：
  //   data: {"choices":[{"delta":{"content":"你"}}]}
  //   data: [DONE]
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    // SSE 事件以 \n 分隔，缓冲区里可能有不完整的帧，只处理到最后一个换行
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue

      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        console.log('\n\n[流结束]')
        return
      }

      const chunk = JSON.parse(payload)
      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        process.stdout.write(delta) // 逐 token 打印，不换行
      }
    }
  }
}

const messages: Message[] = [
  { role: 'user', content: '用 3 个要点说明 Agent 和普通聊天机器人的区别' },
]

console.log('流式回复：\n')
await chatStream(messages)
