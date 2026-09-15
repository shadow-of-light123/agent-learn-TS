/**
 * 第 6 课：MCP —— 手写客户端，把线上原始报文原样打印出来
 *
 * 这个文件的目的只有一个：**让你看见字节**。
 * 平时用 SDK，你看到的是 `client.callTool(...)`；这里你看到的是真的 JSON-RPC。
 *
 * 它做的事：
 *   1. 把 server-raw.ts 作为**子进程**拉起来
 *   2. 通过它的 stdin 发 JSON-RPC 请求
 *   3. 从它的 stdout 读 JSON-RPC 响应
 *   4. 把两个方向上的每一条原始报文都打印出来
 *
 * 配套命令：npm run l6:raw
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（谁不能乱打印）服务端**绝不能**往 stdout 打日志，因为那是协议通道；
 *      客户端**可以**随便往 stdout 打，因为客户端的 stdout 就是你的终端。
 *      这个不对称一开始很反直觉，想清楚"谁的 stdout 被当成协议用了"就通了。
 *
 *      想亲眼看看踩坑是什么样：在 server-raw.ts 里加一行
 *        console.log('服务器启动了')
 *      再跑一次，客户端会立刻在某条响应上 JSON 解析失败 —— 而且报错信息
 *      完全指不到"是那行日志干的"。这就是为什么这个坑能坑人一下午。
 *
 *   ★ 2（stderr 是分开的）我们用 stdio: ['pipe','pipe','inherit']，
 *      把子进程的 stderr **直接接到我们的终端**。所以下面看到的
 *      `[server] xxx` 全是从 stderr 过来的，跟协议通道一点关系都没有。
 *      生产里你应该把 stderr 收进日志系统，而不是丢掉。
 *
 *   ★ 3（进程生命周期）客户端退出时必须**主动杀掉子进程**，否则留下孤儿进程。
 *      Windows 上的 kill 语义和 POSIX 不一样（没有信号那套），Node 会退化成
 *      强杀进程树。所以别依赖"温柔地通知它退出"，要留好兜底。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server-raw.ts')

// 跟 server-raw.ts 里写的必须是同一个值，否则真实实现里就该断开连接了
const PROTOCOL_VERSION = '2025-03-26'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

// ---------- 拉起子进程 ----------

// ★ stdio 三件套的分工：
//   stdin  → 我们写请求       (pipe)
//   stdout ← 我们读响应       (pipe)  —— 协议通道
//   stderr ← 直接透传到终端   (inherit) —— 日志通道
const child = spawn(process.execPath, ['--import', 'tsx', SERVER_PATH], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

// JSON-RPC 的 id 可以是字符串也可以是数字，统一按字符串当键，省得类型对不上
const pending = new Map<string, (msg: JsonRpcResponse) => void>()
let nextId = 1

function wire(direction: '→' | '←', message: unknown): void {
  const text = typeof message === 'string' ? message : JSON.stringify(message)
  console.log(`  ${direction}  ${text}`)
}

// 请求：有 id，等对方回
function request(method: string, params?: unknown): Promise<JsonRpcResponse> {
  const id = nextId++
  const message = { jsonrpc: '2.0', id, method, params }
  wire('→', message)
  child.stdin.write(`${JSON.stringify(message)}\n`)
  return new Promise((resolve) => pending.set(String(id), resolve))
}

// 通知：★ 没有 id，对方不该回复（也等不到回复）
function notify(method: string, params?: unknown): void {
  const message = { jsonrpc: '2.0', method, params }
  wire('→', message)
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

// ---------- 读响应 ----------

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => {
  buffer += chunk
  let newline: number
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue

    wire('←', line)

    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      // ★ 走到这里，十有八九是服务端往 stdout 打了日志。
      //   注意这个报错**指不到**真正的原因 —— 这正是该坑最恶心的地方。
      console.error(`\n  ✗ 收到不是 JSON 的内容：${line.slice(0, 80)}`)
      console.error('    最可能的原因：服务端往 stdout 打了日志。日志必须走 stderr。\n')
      continue
    }

    if (message.id !== undefined) pending.get(String(message.id))?.(message)
  }
})

child.on('exit', (code) => console.log(`\n  [子进程退出，code=${code}]`))

// ---------- 演示 ----------

function divider(title: string): void {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`)
}

async function main(): Promise<void> {
  divider('1. 握手：initialize')
  console.log('  客户端提议协议版本，服务端确认自己用哪个，并声明自己有哪些能力。')
  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'demo-client', version: '1.0.0' },
  })
  console.log(`  → 服务端：${JSON.stringify(init.result)}\n`)

  console.log('  握手完还要发一条 initialized 通知 —— ★ 注意它没有 id，服务端不会回。')
  notify('notifications/initialized')
  await sleep(150) // 给它一点时间把 stderr 的日志刷出来

  divider('2. 发现工具：tools/list')
  console.log('  这一步返回的就是第 2 课你手写过的那份 JSON Schema。')
  const list = await request('tools/list')
  const tools = (list.result?.tools ?? []) as { name: string; description: string }[]
  for (const t of tools) {
    console.log(`  · ${t.name} —— ${t.description}`)
  }

  divider('3. 调用工具：tools/call（正常情况）')
  const weather = await request('tools/call', {
    name: 'get_weather',
    arguments: { city: '北京' },
  })
  console.log(`  → ${JSON.stringify(weather.result)}`)

  divider('4. 工具自己失败（边界情况一）')
  console.log('  表达式非法。★ 注意这**不是** JSON-RPC 错误 ——')
  console.log('  协议层一切正常，只是结果里带了 isError: true。')
  const bad = await request('tools/call', {
    name: 'calculate',
    arguments: { expression: 'process.exit(1)' },
  })
  console.log(`  → ${JSON.stringify(bad.result)}`)

  divider('5. 工具名不存在（边界情况二）')
  console.log('  这是**协议级**错误 —— 方法存在，但参数里的工具名没人认识，')
  console.log('  所以返回的是 JSON-RPC 的 error 字段，而不是 result。')
  const missing = await request('tools/call', { name: 'no_such_tool', arguments: {} })
  console.log(`  → ${JSON.stringify(missing.error)}`)

  divider('小结')
  console.log('  协议的全部内容就是上面这五步。没有注册中心、没有 SDK 魔法、')
  console.log('  没有要背的规范 —— 三个方法 + 一条通知，一行一条 JSON。')
  console.log('  server-sdk.ts 会用官方 SDK 把同一个服务端再写一遍，你可以对比行数。')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

try {
  await main()
} finally {
  // ★ 一定要收尾，否则子进程会一直挂着
  child.stdin.end()
  child.kill()
}
