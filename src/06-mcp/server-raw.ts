/**
 * 第 6 课：MCP —— 手写一个 server，先把协议看穿
 *
 * 前五课，工具都是**写死在 Agent 代码里**的：`toolRegistry` 那个对象。
 * 想加个工具？改代码、重新部署。想用别人写好的工具？把代码拷过来。
 *
 * MCP（Model Context Protocol）要解决的就是这件事：把「工具的提供方」和
 * 「工具的使用方」拆成两个进程，中间用一套标准协议通信。工具从此变成**可插拔**的。
 *
 * 而它本身没有任何魔法 —— 就是 **JSON-RPC 2.0，一行一条 JSON，走 stdin/stdout**。
 * 这个文件就是把这份"魔法"手动拆开给你看：
 *
 *   客户端发 {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}} 到我们的 stdin
 *   我们从 stdout 回 {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * 全程只有三个方法：
 *
 *   initialize    握手 + 能力协商（我用哪个协议版本、我支持哪些能力）
 *   tools/list    我有哪些工具（名字、描述、参数的 JSON Schema）
 *   tools/call    执行某个工具，返回结果
 *
 * 配对的客户端在 client-raw.ts。先用 `npm run l6:raw` 看原始报文。
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（stdout 是协议通道，日志必须走 stderr）
 *      这是新手**最常踩**的坑，没有之一。你只要在 server 里写一行
 *      `console.log('服务器启动了')`，客户端就会收到一行不是 JSON 的东西，
 *      解析直接炸。更糟的是报错信息通常只说"JSON 解析失败"，完全指不到真正的原因。
 *      本文件里所有日志一律 console.error —— 这就是"日志走 stderr"的意思。
 *      这不是江湖传言：官方 SDK 文档里专门有一节叫 "Log to stderr, never stdout"。
 *
 *   ★ 2（printf 调试的两种用法）
 *      process.stdout.write 是协议，process.stderr.write 是人看的。分清楚，
 *      你就再也不会遇到"加了句日志就崩"的问题。
 *
 *   ★ 3（通知不需要回复）
 *      JSON-RPC 里**没有 id 的消息叫"通知"（notification），必须不能回复**。
 *      客户端握手完会发一条 notifications/initialized，你如果手贱回一个响应，
 *      协议就对不上了。判别方法很简单：看有没有 id。
 *
 *   ★ 4（这里的 JSON Schema 又是手写的）
 *      第 2 课手写 JSON Schema → 第 3 课改用 zod 生成（因为 schema 和实现都在自己手里）。
 *      到了 MCP，schema 要跨进程边界送给别人，zod 对象过不去，**只能退回手写 JSON Schema**。
 *      这个来回本身就说明了一件事：schema 属于谁，决定了你怎么写它。
 */

// ★ 协议版本。真实协商里是客户端提议、服务端确认；两边谈不拢就该断开。
// 这里客户端和服务端都是我们自己写的，所以约定同一个值即可。
// 官方 SDK v2 的取值可以这样查（本仓库实测）：LATEST = '2025-11-25'，
// 默认协商结果是 '2025-03-26'。我们手写，取后者，简单够用。
const PROTOCOL_VERSION = '2025-03-26'

const SERVER_NAME = 'demo-tools'
const SERVER_VERSION = '1.0.0'

// ---------- 工具实现（跟第 3 课一模一样，变的是它们现在住在另一个进程里） ----------

interface RawTool {
  name: string
  description: string
  inputSchema: Record<string, unknown> // 手写 JSON Schema，见文件头 ★ 4
  run: (args: Record<string, unknown>) => string
}

const weatherData: Record<string, string> = {
  北京: '晴，12°C，空气质量优，风力 3 级',
  上海: '多云，18°C，空气质量良，湿度 80%',
}

const tools: RawTool[] = [
  {
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 北京' },
      },
      required: ['city'],
    },
    run: ({ city }) => JSON.stringify({ city, weather: weatherData[String(city)] ?? '暂无数据' }),
  },
  {
    name: 'calculate',
    description: '计算一个数学表达式，返回数值结果',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式，如 (12-18)*1.8' },
      },
      required: ['expression'],
    },
    run: ({ expression }) => {
      // 白名单卡住字符集，别让任意 JS 进 new Function —— 跟第 3 课同一道防线
      const expr = String(expression)
      if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
        throw new Error('只允许由数字和 + - * / ( ) 组成的算式')
      }
      return JSON.stringify({ expression: expr, value: new Function(`return (${expr})`)() })
    },
  },
]

// ---------- JSON-RPC 收发 ----------

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number // ★ 没有 id = 通知，必须不回复
  method: string
  params?: Record<string, unknown>
}

function send(message: unknown): void {
  // ★ 这是协议通道，只能写 JSON-RPC
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id: string | number, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function log(...args: unknown[]): void {
  // ★ 日志一律走 stderr —— 见文件头 ★ 1
  console.error('[server]', ...args)
}

// ---------- 三个方法 ----------

function handleInitialize(id: string | number, params: Record<string, unknown> | undefined): void {
  const clientVersion = (params?.protocolVersion as string) ?? '(未提供)'
  log(`客户端请求协议版本 ${clientVersion}，我们回复 ${PROTOCOL_VERSION}`)

  reply(id, {
    protocolVersion: PROTOCOL_VERSION,
    // 能力协商：我们只提供 tools，不提供 resources / prompts。
    // 客户端据此知道该不该调 resources/list —— 别让对方去试错。
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  })
}

function handleToolsList(id: string | number): void {
  reply(id, {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  })
}

function handleToolsCall(id: string | number, params: Record<string, unknown> | undefined): void {
  const name = params?.name as string
  const args = (params?.arguments as Record<string, unknown>) ?? {}
  const tool = tools.find((t) => t.name === name)

  if (!tool) {
    // 协议级错误：方法找得到，但参数里的工具名不存在
    replyError(id, -32602, `未知工具: ${name}`)
    return
  }

  try {
    const text = tool.run(args)
    // ★ 结果是一组**内容块**，不是裸字符串。这样同一个字段既能放文本，
    //   也能放图片、音频、结构化数据 —— 是留给未来的扩展位。
    reply(id, { content: [{ type: 'text', text }] })
  } catch (e) {
    // ★ 工具自己执行失败**不是协议错误**，仍然是一次成功的响应，
    //   只是把 isError 标上。这跟第 3 课 executeTool "错误当数据回传、不当异常抛"
    //   是同一个设计 —— 让模型能看到失败原因并自己改。
    reply(id, { content: [{ type: 'text', text: String(e) }], isError: true })
  }
}

const HANDLERS: Record<string, (id: string | number, params?: Record<string, unknown>) => void> = {
  initialize: handleInitialize,
  'tools/list': handleToolsList,
  'tools/call': handleToolsCall,
}

// ---------- 主循环：从 stdin 一行一行读 ----------

let buffer = ''
process.stdin.setEncoding('utf8')

process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  // 网络和管道都不保证"一条消息一次到达"，必须自己按换行切
  let newline: number
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handleLine(line)
  }
})

process.stdin.on('end', () => {
  log('stdin 关闭，退出')
  process.exit(0)
})

function handleLine(line: string): void {
  let request: JsonRpcRequest
  try {
    request = JSON.parse(line) as JsonRpcRequest
  } catch {
    log('收到不是 JSON 的东西：', line.slice(0, 120))
    // 没有 id 就连错误响应都没法发（发出去对方也对不上），只能记日志
    return
  }

  log(`← ${request.method}`)

  const handler = HANDLERS[request.method]

  if (!handler) {
    // ★ 通知（没有 id）即使方法不认识也必须静默 —— 回复了反而破坏协议
    if (request.id === undefined) return
    replyError(request.id, -32601, `未实现的方法: ${request.method}`)
    return
  }

  if (request.id === undefined) {
    // 通知：执行语义（如果有），但绝不回复
    log(`（通知，不回复）`)
    return
  }

  handler(request.id, request.params)
}

log(`已启动，等待 stdin 上的 JSON-RPC（协议版本 ${PROTOCOL_VERSION}）`)
log(`暴露 ${tools.length} 个工具：${tools.map((t) => t.name).join(', ')}`)
