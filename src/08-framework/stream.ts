/**
 * 第 8 课 · Part 2：流式（把第 1 课的 SSE 用在 Agent 上）
 *
 * 第 1 课你手写过 SSE 解析：fetch 拿 ReadableStream、按行切、剥掉 "data: " 前缀、
 * 认 [DONE]、取 delta.content 逐 token 打印。那是**单轮对话**的流式。
 *
 * ★ 但 Agent 的流式完全是另一回事，因为流里还夹着工具调用：
 *
 *   单轮对话：delta.content 一路流到底，拼接即所得。
 *   Agent：  模型可能先流一段"我来查一下天气"，然后话锋一转去点菜 ——
 *            而 tool_calls 的参数在协议里是**分片到达**的：
 *
 *              delta.tool_calls: [{ index: 0, function: { name: 'get_weather' } }]
 *              delta.tool_calls: [{ index: 0, function: { arguments: '{"ci' } }]
 *              delta.tool_calls: [{ index: 0, function: { arguments: 'ty":' } }]
 *              delta.tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }]
 *
 *            你得按 index 分组、把 arguments 一片片拼起来、再 JSON.parse
 *            （第 2 课你已经知道这段字符串不可信）。
 *            而且工具一执行，对话就得"暂停"，等结果回来再继续流 ——
 *            前端那根打字光标要停住，这和第 1 课一口气流到底的手感完全不同。
 *
 * 这些活 LangChain 替你干了。你要学的是：它在哪一层把它干掉了、
 * 以及它交还给你的是哪两个迭代器。
 */

import { createAgent, tool } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: process.env.DEEPSEEK_API_KEY,
  configuration: { baseURL: BASE_URL },
})

const tools = [
  tool(({ city }) => {
    const data: Record<string, string> = {
      北京: '晴，12°C，空气质量优，风力 3 级',
      上海: '多云，18°C，空气质量良，湿度 80%',
    }
    return JSON.stringify({ city, weather: data[city] ?? '暂无数据' })
  }, {
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    schema: z.object({ city: z.string().min(1).describe('城市名，如 北京') }),
  }),

  tool(({ expression }) => {
    const value = new Function(`return (${expression})`)()
    return JSON.stringify({ expression, value })
  }, {
    name: 'calculate',
    description: '计算一个数学表达式，返回数值结果',
    schema: z.object({
      expression: z
        .string()
        .regex(/^[0-9+\-*/().\s]+$/, '只允许由数字和 + - * / ( ) 组成的算式')
        .describe('数学表达式，如 (12-18)*1.8'),
    }),
  }),
]

const agent = createAgent({ model, tools })

const QUESTION = '查一下北京和上海现在的天气，哪个城市更适合跑步？两地温差是多少摄氏度？请用计算工具算温差。'

console.log('提问：', QUESTION, '\n')
console.log('--- 流式输出开始（注意工具调用的插播）---\n')

// ★ version: 'v3' 是目前的事件流协议版本。换成别的版本，下面这两个迭代器的
//   形状会不一样 —— 框架的流式 API 是目前变动最频繁的一块，升级时优先看这里。
const stream = await agent.streamEvents(
  { messages: [{ role: 'user', content: QUESTION }] },
  { version: 'v3' },
)

// 两个迭代器，各管一摊：
//
//   stream.messages  —— 按"消息"分组。每条消息的 .text 又是一个迭代器，
//                       逐 token 吐字。这就是第 1 课的 delta.content，
//                       只不过被按消息切好、顺序也帮你排好了。
//
//   stream.toolCalls —— 完整的工具调用（name + input 都拼好了、parse 过了）。
//                       第 2 课你手动拼 arguments 分片的那段代码，在这里变成了一行 for await。
//
// ★ 两个必须同时消费。它们是同一个底层流的两条支流，只读其中一条，
//   另一条会把数据积在缓冲区里 —— 所以用 Promise.all 并发跑（官方示例也是这么写的）。
await Promise.all([
  (async () => {
    for await (const message of stream.messages) {
      for await (const token of message.text) {
        process.stdout.write(token)
      }
    }
  })(),

  (async () => {
    for await (const call of stream.toolCalls) {
      // 工具调用是"插播"进来的：文字流到这里会停，等工具执行完再继续。
      // 第 1 课那种"一口气流到底"的进度条逻辑，在这里必须改成"可能中断"的
      process.stdout.write(`\n\n  ⚙  调用 ${call.name}(${JSON.stringify(call.input)})\n\n`)
    }
  })(),
])

console.log('\n\n--- 流结束 ---')

// ────────────────────────────────────────────────────────────────
// 回头看第 1 课的对比：
//
//   第 1 课（手写 50 行）：  reader / TextDecoder / buffer 切行 / "data: " 前缀 /
//                            [DONE] / JSON.parse / 取 delta.content
//   这里（手写 2 行）：      for await (const m of stream.messages)
//                              for await (const t of m.text)
//
// 省掉的不只是代码量，更是**协议知识**：SSE 帧格式、分片拼装、工具调用中断。
// 但代价也在这里 —— 如果哪天流式出了问题（token 丢了、工具调用顺序乱了、
// 光标不停），你需要知道"这些问题原本出在哪一层"才查得下去。
// 第 1 课那 50 行就是你的地图。
// ────────────────────────────────────────────────────────────────
