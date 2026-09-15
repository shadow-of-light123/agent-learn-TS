/**
 * 第 6 课：MCP —— 用官方 SDK 把同一个 server 再写一遍
 *
 * 拿它跟 server-raw.ts 对比着看，本课的重点就出来了：
 *
 *   server-raw.ts   手写 JSON-RPC 收发、手写 schema、手写错误码、手写换行切分
 *   server-sdk.ts   serveStdio + registerTool，剩下的 SDK 全包
 *
 * 行数少了一大半，而且少掉的**全是容易写错的部分**：换行切分的边界、
 * 通知不该回复、错误码该用哪个、能力协商怎么表达。这些手写版里我都要用 ★ 标出来
 * 提醒你别踩，SDK 版里它们根本不存在 —— 因为压根不用你写。
 *
 * 这就是"知道原理"和"每次自己实现"的区别：
 * 看懂协议是为了**排查**（第 3 课那个循环挖出来的能力），
 * 用 SDK 是为了**干活**。两件事不冲突，都得会。
 *
 * ── 一个漂亮的回环 ──
 *
 * 注意下面的 inputSchema 写的是 z.object({...})。
 * 第 2 课你**手写** JSON Schema → 第 3 课改用 **zod 生成**（toToolSchema），
 * 因为那时 schema 和实现都在你自己手里。现在 MCP 要把它送出进程边界，
 * 你**又回到手写** JSON Schema（server-raw.ts）。
 *
 * 而 SDK 把这一步又收了回去：你给 zod，它替你转 JSON Schema ——
 * 等于把第 3 课那个 toToolSchema 内置了。
 *
 * 所以"schema 该不该用 zod 写"没有标准答案，答案取决于：**这份 schema 归谁管。**
 *
 * 启动方式不是直接跑，而是被客户端当子进程拉起来：
 *   npm run l6:sdk     （client-sdk.ts 会 spawn 本文件）
 *
 * ⚠️ 版本提示：v2 的 inputSchema 要传 z.object({...})。
 *    你在网上看到的大量中文教程写的是 v1 的裸 shape 写法
 *      { city: z.string() }        // ← 这是 v1
 *    两者不通用，照抄会报错。认准你装的版本。
 */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const weatherData: Record<string, string> = {
  北京: '晴，12°C，空气质量优，风力 3 级',
  上海: '多云，18°C，空气质量良，湿度 80%',
}

// ★ serveStdio 要的是一个**工厂函数**，不是一个现成的 server 实例。
// 原因是 v2 会按连接做协议代际协商，每个连接需要一份干净的实例。
// 这也是 v2 相对 v1 最明显的写法变化 —— v1 是
//   const t = new StdioServerTransport(); await server.connect(t)
// 老代码迁过来要改这一处。
serveStdio(() => {
  const server = new McpServer({ name: 'demo-tools', version: '1.0.0' })

  server.registerTool(
    'get_weather',
    {
      description: '查询指定城市的实时天气',
      inputSchema: z.object({
        city: z.string().min(1).describe('城市名，如 北京'),
      }),
    },
    async ({ city }) => ({
      // 返回的是一组**内容块** —— 跟 server-raw.ts 里手写的结构完全一致，
      // 只是 SDK 帮我们把对象拼好了
      content: [{ type: 'text', text: JSON.stringify({ city, weather: weatherData[city] ?? '暂无数据' }) }],
    }),
  )

  server.registerTool(
    'calculate',
    {
      description: '计算一个数学表达式，返回数值结果',
      inputSchema: z.object({
        // 跟第 3 课同一道白名单防线。zod 在这里的作用和课堂上一模一样：
        // 校验发生在**服务端**，客户端传什么都拦得住
        expression: z
          .string()
          .regex(/^[0-9+\-*/().\s]+$/, '只允许由数字和 + - * / ( ) 组成的算式')
          .describe('数学表达式，如 (12-18)*1.8'),
      }),
    },
    async ({ expression }) => {
      const value = new Function(`return (${expression})`)()
      return { content: [{ type: 'text', text: JSON.stringify({ expression, value }) }] }
    },
  )

  // 日志走 stderr —— 这条规矩在 SDK 版里同样成立。
  // console.log 会污染 stdout 的协议通道，SDK 救不了你。
  console.error('[server-sdk] 已注册 2 个工具：get_weather, calculate')

  return server
})
