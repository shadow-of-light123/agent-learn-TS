/**
 * 第 6 课：MCP —— 用官方 SDK 把 client-raw.ts 再写一遍
 *
 * **同样五个步骤**，你对比着看两个文件的长度和长相：
 *
 *   client-raw.ts   自己 spawn、自己拼 JSON-RPC、自己按换行切 buffer、自己按 id 配对请求响应
 *   client-sdk.ts   connect / listTools / callTool —— 就这三个词
 *
 * 少的不是"样板代码"，是**所有会写错的地方**。手写版里我标了三个 ★ 提醒你别踩；
 * SDK 版里一个都不需要，因为那些事压根不归你管。
 *
 * 配套命令：npm run l6:sdk
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server-sdk.ts')

function divider(title: string): void {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`)
}

// ---------- 连接 ----------

// ★ StdioClientTransport 在背后替你干了 client-raw.ts 里那一大坨：
//   spawn 子进程、写 stdin、按换行切 stdout、按 id 配对、握手、超时、退出清理。
//   它甚至用的不是原生 child_process，而是 cross-spawn —— 就为了在 Windows 上行为一致。
const client = new Client({ name: 'demo-client', version: '1.0.0' })

divider('连接')
console.log(`  拉起子进程：${path.basename(SERVER_PATH)}`)
console.log('  connect() 内部自动完成了：spawn → initialize 握手 → initialized 通知')
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', SERVER_PATH],
    // stderr 默认就是 'inherit'，所以服务端的日志会照常出现在这个终端里
  }),
)

// ---------- 2. 发现工具 ----------

divider('发现工具：listTools()')
// ★ 注意 listTools() 没有 cursor 参数 —— SDK 自动帮你翻完了所有分页。
//   手写的话你得自己处理 nextCursor，这是又一个"只有自己写才知道麻烦"的地方。
const { tools } = await client.listTools()
for (const t of tools) {
  console.log(`  · ${t.name} —— ${t.description}`)
  console.log(`    参数：${JSON.stringify(t.inputSchema)}`)
}
console.log('\n  ↑ 这份 inputSchema 就是第 2 课你手写过、第 3 课用 zod 生成过的东西。')

// ---------- 3. 调用工具 ----------

divider('调用工具：callTool()（正常情况）')
const weather = await client.callTool({ name: 'get_weather', arguments: { city: '北京' } })
console.log(`  → ${JSON.stringify(weather.content)}`)

divider('工具自己失败（边界情况一）')
// ★ callTool **不抛异常**。工具执行失败时它正常 resolve，只是带上 isError: true。
//   这跟第 3 课 executeTool "错误当数据回传、不当异常抛" 是同一个设计 ——
//   因为错误最终是要**喂回给模型**的，抛异常反而要多写 try/catch 去捞回来。
const bad = await client.callTool({ name: 'calculate', arguments: { expression: 'process.exit(1)' } })
console.log(`  isError = ${bad.isError}`)
console.log(`  → ${JSON.stringify(bad.content)}`)

divider('工具名不存在（边界情况二）')
// 这个是协议级错误，SDK 会抛。两种失败要分清 —— 这正是 server-raw.ts 里
// 区分"回 error 字段"和"回 result + isError"的原因。
try {
  await client.callTool({ name: 'no_such_tool', arguments: {} })
  console.log('  （没有抛异常，出乎意料）')
} catch (e) {
  console.log(`  抛异常了：${String(e).slice(0, 120)}`)
  console.log('  ↑ 协议级错误抛异常，工具级错误当数据返回 —— 分界线就在这里。')
}

// ---------- 对比 ----------

divider('对比：手写 vs SDK')
const count = (f: string): number => fs.readFileSync(path.join(HERE, f), 'utf8').split('\n').length
console.log(`  client-raw.ts   ${count('client-raw.ts')} 行   （含大量注释和 ★ 说明）`)
console.log(`  client-sdk.ts   ${count('client-sdk.ts')} 行`)
console.log(`  server-raw.ts   ${count('server-raw.ts')} 行`)
console.log(`  server-sdk.ts   ${count('server-sdk.ts')} 行`)
console.log('\n  行数差不是重点，重点是手写版里那些 ★ 标记的坑 ——')
console.log('  stdout 不能打日志、通知不能回复、buffer 要按换行切、错误分两级。')
console.log('  这些你已经踩过一遍了，所以以后 SDK 出问题时你知道该往哪看。')

await client.close()
console.log('\n  连接已关闭。')
