/**
 * 第 6 课：MCP —— 把外部工具接进自己的 Agent（本课的落点）
 *
 * 前面三个文件都在讲"协议长什么样"。这个文件回答的是**"那又怎样"**：
 *
 *   第 3 课那套工具，是我们**写死在 Agent 代码里**的 `toolRegistry`。
 *   现在工具跑在**另一个进程**里，通过 MCP 暴露出来，
 *   而我们的 Agent **一行工具实现都没写**，却能照常调用它们。
 *
 * 而循环本身 —— 第 3 课那个 while —— **一个字都没改**。
 *
 *   tools/list  → 拿到工具清单和 JSON Schema → 喂给模型
 *   模型返回 tool_calls → tools/call 转给 MCP server → 结果喂回模型
 *
 * 这就是"协议"的价值：你的 Agent 内核不用为每个新工具改一次代码。
 * 工具从"代码的一部分"变成了"可插拔的外部依赖"。
 *
 * 配套命令：npm run l6:agent（会拉起 server-sdk.ts）
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（schema 的归属，本课最该带走的一句）
 *      第 2 课**手写** JSON Schema → 第 3 课改用 **zod 生成**（因为 schema 和实现
 *      都在自己手里，zod 能同时给出 JSON Schema、运行时校验和 TS 类型）。
 *      到了 MCP，工具是**别人递给你**的，只有一份 JSON Schema —— 你没法把它变回 zod
 *      （除非再引一个转换库，而且 type/schema 对不齐的地方还得手工兜）。
 *
 *      所以这里**不做反转**，而是老实定义一个平行的契约 McpTool。
 *      真正的结论是：
 *
 *        **MCP 给你的 schema，是一份你不拥有的契约。**
 *
 *      第 3 课你能在 executeTool 里用 safeParse 亲手拦一遍参数，因为 schema 是你的；
 *      这里你拦不了 —— 校验发生在**服务端**，你只能转发。这是权力的转移，
 *      也是安全问题的起点（见 ★ 3）。
 *
 *   ★ 2（execute 变成了 async —— 第二次撞墙）
 *      第 5 课的检索工具要发网络请求，第一次把第 3 课的同步 execute 顶破了。
 *      这里又来一次：callTool 天生是异步的。
 *      所以 executeTool 不能照抄第 3 课，得重写一个 async 版本。
 *      所有框架最后都会收敛到「一个 async 工具接口」，原因就是这个 ——
 *      工具一旦可能涉及 IO，"同步"就是个撑不住的假设。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server-sdk.ts')

// 对话模型还是 DeepSeek（跟第 1~5 课一样）。MCP 管的是工具，不管模型。
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

type Role = 'system' | 'user' | 'assistant' | 'tool'

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface Message {
  role: Role
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

type AssistantMessage = Omit<Message, 'role'> & { role: 'assistant' }

// ---------- 工具契约：★ 注意它跟第 3 课的 Tool<S> 长得不一样 ----------

// 第 3 课的版本：
//   interface Tool<S extends z.ZodType> {
//     description: string
//     argsSchema: S                                  // ← zod，我们拥有它
//     execute: (args: z.infer<S>) => string          // ← 同步
//   }
//
// MCP 版本的现实是：schema 是服务器给的 JSON Schema，参数类型我们根本不知道，
// 校验也在对面做。硬套 zod 只会得到一个自欺欺人的类型。
interface McpTool {
  description: string
  parameters: Record<string, unknown> // JSON Schema，原样透传给模型 —— 我们只是搬运工
  execute: (args: Record<string, unknown>) => Promise<string> // ★ async，见 ★ 2
}

// ---------- 连接 MCP server，把它的工具变成我们的注册表 ----------

const client = new Client({ name: 'agent-client', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', SERVER_PATH] }))

// ★ 这一行就是"可插拔"的全部实现：tools/list 走一趟，工具就有了。
//   想加新工具？改 server，不用碰 Agent 代码，更不用重新部署这个进程。
const { tools: advertised } = await client.listTools()

function toApiToolSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  // 跟第 3 课一样剥掉 $schema：有些供应商不认这个字段
  const { $schema, ...rest } = parameters
  return rest
}

// MCP 的结果是一组**内容块**，要拍平成字符串才能喂给模型
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content
    .map((block) =>
      block && typeof block === 'object' && 'text' in block
        ? String((block as { text: unknown }).text)
        : JSON.stringify(block),
    )
    .join('\n')
}

const registry: Record<string, McpTool> = Object.fromEntries(
  advertised.map((t) => [
    t.name,
    {
      description: t.description ?? '',
      parameters: toApiToolSchema(t.inputSchema as Record<string, unknown>),
      execute: async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: t.name, arguments: args })
        const text = contentToText(result.content)
        // callTool 失败时**不抛异常**，只是 isError 标上 —— 跟第 3 课
        // "错误当数据回传"同一个设计，所以这里原样把错误文本交还给模型
        return result.isError ? JSON.stringify({ error: text }) : text
      },
    },
  ]),
)

const toolDefs = Object.entries(registry).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: t.parameters },
}))

// ---------- 通用的工具执行器（★ 第 3 课是同步的，这里必须重写成 async） ----------

async function executeTool(toolCall: { id: string; function: { name: string; arguments: string } }): Promise<string> {
  const tool = registry[toolCall.function.name]
  if (!tool) return JSON.stringify({ error: `未知工具: ${toolCall.function.name}` })

  let raw: unknown
  try {
    raw = JSON.parse(toolCall.function.arguments)
  } catch {
    return JSON.stringify({ error: `参数不是合法 JSON: ${toolCall.function.arguments}` })
  }

  // ★ 注意这里**没有 safeParse 那道关**了 —— 第 3 课能本地校验，是因为 schema 是我们的。
  //   现在校验在服务端，我们只能转发。这不是偷懒，是事实。
  //   如果你想在本地也拦一道，就得自己写校验，或者信任对面 —— 这是个真实的取舍。
  try {
    return await tool.execute(raw as Record<string, unknown>)
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ---------- 对话模型 ----------

async function callModel(messages: Message[]): Promise<AssistantMessage> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: toolDefs }),
  })
  if (!res.ok) throw new Error(`API 错误 ${res.status}: ${await res.text()}`)
  return (await res.json()).choices[0].message as AssistantMessage
}

// ---------- Agent Loop：第 3 课那个循环，一个字都没改 ----------

const MAX_ITERATIONS = 10

async function agent(question: string): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: '你是一个严谨的助手，回答简洁。需要查资料或计算时，调用你可以使用的工具。' },
    { role: 'user', content: question },
  ]

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const msg = await callModel(messages)

    if (!msg.tool_calls?.length) {
      console.log(`  [第 ${i} 轮] 模型给出最终回答，循环结束`)
      return msg.content ?? ''
    }

    messages.push(msg)
    for (const toolCall of msg.tool_calls) {
      console.log(`  [第 ${i} 轮] 调用 ${toolCall.function.name}(${toolCall.function.arguments})`)
      const result = await executeTool(toolCall)
      console.log(`          ↳ ${result}`)
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }

  throw new Error(`超过最大轮数 ${MAX_ITERATIONS}，强制终止`)
}

// ---------- 跑 ----------

if (!API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 里配置')

console.log('='.repeat(64))
console.log('MCP 工具已就绪')
console.log('='.repeat(64))
console.log(`  来源：${path.basename(SERVER_PATH)}（另一个进程，通过 MCP 通信）`)
for (const [name, t] of Object.entries(registry)) {
  console.log(`  · ${name} —— ${t.description}`)
}
console.log('\n  ↑ 这些工具的实现，本文件一行都没有写。')

// 故意用**和第 3 课完全相同**的问题：那次工具写在代码里，这次工具来自外部进程。
// 循环没变、模型没变、问题没变 —— 变的只有工具的来源。
const QUESTION = '查一下北京和上海现在的天气，哪个城市更适合跑步？两地温差是多少摄氏度？请用计算工具算温差。'

console.log(`\n${'='.repeat(64)}\n问题\n${'='.repeat(64)}`)
console.log(`  ${QUESTION}\n`)
console.log(await agent(QUESTION))

// ★ 3（安全）连上别人的 MCP server，等于把**工具执行权**交出去。
//   第 3 课 calculate 的字符白名单是防**模型**乱来；这里要防的是**工具提供方** ——
//   它拿到你的参数想干什么，你管不着。所以：
//     · 只连你信任的 server（第三方 server 就是一段你准备运行的陌生代码）
//     · 能本地校验的参数就本地再校验一遍（别因为"对面会校验"就省掉）
//     · 想清楚它拿到的参数里有没有敏感信息
//   还有一层更少人知道的：MCP server 可以反向向 client 请求 **sampling**（让模型替它生成）
//   和 **elicitation**（问你问题）。也就是说 client 不只是"调用方"，
//   它同时是"被请求方"。连之前先想清楚你愿意授权到什么程度。

await client.close()
console.log('\n  连接已关闭。')
