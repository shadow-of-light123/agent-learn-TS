# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

一个中文「从零手写 Agent」教程仓库。用 TypeScript + Node 原生 `fetch` 直调 LLM API，**刻意不抽公共模块**：每一课的文件都自成一体，可以单独打开阅读、单独运行。课程按 01→09 递进，后一课会重复前一课的部分代码，这是为了教学可读性，不是技术债 —— 重构前先确认这是你想要的改动。

每课文件头的长注释是教材正文（含大量 `★` 标记的核心认知和踩坑记录），修改代码时要同步维护，不要当成普通注释删掉。

## 常用命令

```bash
npm install
cp .env.example .env      # 填 DEEPSEEK_API_KEY + SILICONFLOW_API_KEY

npm run l1                # 各课主入口，l1 ~ l9
npm run l1:stream         # 单轮 SSE 流式
npm run l4:test           # 用管道喂 test-input.txt，复现摘要压缩
npm run l5:test           # 用管道喂 test-input.txt，非交互跑完三个 demo（含"语料里没有"的诚实性检查）
npm run l5:explore        # 只看 RAG 检索层，不调对话模型
npm run l6:raw            # 手写 JSON-RPC 的 MCP，打印原始报文
npm run l6:sdk            # 同一 server 的官方 SDK 版
npm run l6:agent          # MCP 工具接进 Agent Loop
npm run l8:stream         # LangChain 事件流
```

分档参数用 `--` 透传，例如：

```bash
npm run l7 -- 1 8         # 第 7 课 demo 1，城市数 8
npm run l7 -- 2           # 规划者/执行者
npm run l9 -- 2           # 第 9 课换执行器粒度（跑完自动对账）
```

临时覆盖环境变量（PowerShell 语法）：

```powershell
$env:TOKEN_BUDGET='300'; npm run l4
```

**没有测试框架，也没有 lint 配置。** 唯一的静态检查是：

```bash
npx tsc --noEmit
```

所有入口都通过 `node --env-file-if-exists=.env --import tsx` 直接跑 `.ts`，无构建产物、无 watch 模式。

> **需要 Node 22.9+**：`--env-file-if-exists` 是 v22.9 才加的，低版本上所有入口都会直接报 bad option，而不是"忽略 .env"。

> 第 5 课必须有 `SILICONFLOW_API_KEY`（DeepSeek 无 embedding 接口）。第 7、9 课每个 demo 都是多轮 LLM 调用，**别一次全跑**。

## 贯穿全课的统一约定

这些模式在多课中重复出现，改一处通常要跨课保持一致：

1. **zod 是工具定义的单一数据源**（03 课起）：`defineTool({ description, argsSchema, execute })` 同时产出给模型看的 JSON Schema（`toToolSchema`，内部用 `z.toJSONSchema` 并剥掉 `$schema` 字段——部分供应商不认）、运行时校验器和 TS 参数类型。
2. **工具错误是数据，不是异常**（03 课起）：`executeTool` 的未知工具 / JSON 解析失败 / `safeParse` 失败 / 执行抛错，全部 `JSON.stringify({ error })` 回传给模型，让它自己修正重试。MCP 层的 `isError: true` 是同一设计（06 课）。
3. **Agent Loop 的固定形状**（03 课）：先把模型返回的 assistant 消息（含 `tool_calls`）push 进历史，再逐个执行工具并 push `{ role: 'tool', tool_call_id }`；顺序错了 API 报 400。循环出口是「模型没有 `tool_calls`」，并配 `MAX_ITERATIONS` 保险丝。
4. **模型输出一律视为不可信**：`JSON.parse` + zod `safeParse`。09 课的 `jsonCall` 会把校验失败原因回传模型让它改一次（结构化重试）。
5. **token 估算只是教学量尺**：`Math.ceil(JSON.stringify(要发给 API 的字段).length / 2)`，用于 04/07/09 课的成本对账，不是计费精度。04 课先过一层 `toApiView()` 剥掉 `reasoning_content` 之类的思考字段再估算，否则预算被白占。
6. **执行器不要偷偷截断工具结果**：要么完整给模型，要么明确告诉它被截断了（07 课踩过：截断导致分析师浪费一整段抱怨数据不全）。

## 两套模型供应商，别搞混 base URL

- **对话模型**：DeepSeek，OpenAI 兼容格式，`DEEPSEEK_BASE_URL` **不带** `/v1`，拼成 `${BASE_URL}/chat/completions`。默认 `deepseek-flash`（旧名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用），`deepseek-flash` 默认开着思考模式，输出单价约为输入的 4 倍。
- **嵌入模型**：硅基流动 `BAAI/bge-m3`，`SILICONFLOW_BASE_URL` **带** `/v1`，拼成 `${EMB_BASE_URL}/embeddings`。bge-m3 维度固定 1024，不能传 `dimensions`（传了直接 400，code 20015）。
- 错误信封也不同：SiliconFlow 是 `{code, message, data}`，不是 OpenAI 的 `{error:{...}}`，所以统一用 `await res.text()` 打错误。

## 各课核心机制（修改前必看）

| 课 | 入口 | 关键机制 |
|---|---|---|
| 01 | `src/01-hello-llm/` | 裸 fetch、message 角色、手写 SSE 分帧与 `[DONE]` |
| 02 | `src/02-tool-calling/` | tool_calls 协议、`arguments` 是 JSON 字符串 |
| 03 | `src/03-agent-loop/` | while 循环 + zod 工具注册表 |
| 04 | `src/04-memory/` | REPL 多轮、token 预算、摘要压缩 |
| 05 | `src/05-rag/` | 切块、embedding 缓存、余弦、朴素 RAG vs Agentic RAG |
| 06 | `src/06-mcp/` | 手写 JSON-RPC 与官方 SDK v2 对照 |
| 07 | `src/07-multi-agent/` | 单 Agent / 规划者执行者 / 子 Agent 上下文隔离 |
| 08 | `src/08-framework/` | LangChain.js 复刻前面所学 |
| 09 | `src/09-plan-and-execute/` | Planner / Executor / Replanner + 三个旋钮对账 |

几个容易改坏的点：

- **04 课压缩**：切割点只落在 `user` 消息上（保证 `tool_calls` 与 `tool` 结果成对）；两档压缩；压缩后必须真的变小，否则停止（避免每轮白花钱）；工具结果有 `MAX_TOOL_RESULT_CHARS` 上限。REPL 自己维护行队列而不是用 `rl.question`，因为管道输入下 readline 会丢缓冲行——两种模式行为要一致。
- **05 课缓存**：`src/05-rag/.cache/embeddings.json` 被 gitignore，`explore.ts` 与 `index.ts` 共用同一缓存，键是 `模型名:sha1(文本)`。`explore.ts` 里的对照实验（细粒度 / 整篇 / 全语料）是课程内容，别删。
- **06 课 MCP**：server 的 **stdout 是协议通道**，所有日志必须 `console.error`；没有 `id` 的消息是通知，绝不能回复；工具自身失败回 `result + isError`，协议级失败才回 `error` 字段。SDK v2 的写法是 `serveStdio(() => server)` 工厂函数 + `inputSchema: z.object({...})`（v1 的裸 shape 写法不兼容）。客户端 spawn 子进程统一用 `process.execPath` + `--import tsx`，保证 Windows 下行为一致：手写版在 `finally` 里 `stdin.end()` + `kill()`，SDK 版用 `await client.close()` —— 两条路都必须收尾，否则子进程挂着不退。
- **07 / 09 课**：`get_sales('广州')` 是**确定性失败**（永远返回 error），这是为「重规划/改道」设计的教学锚点，不要改成随机失败或修好它。两课用同一道题，方便互相对照。
- **09 课**：`PlanSchema.steps` 有 `.max(6)` 硬上限；`ReplanOutputSchema` 是 `discriminatedUnion('type', ...)`，`continue` / `finish` 由模型决定；还有计划指纹去重 + `MAX_REPLAN = 6` 熔断两道护栏。同一目录下的 `plan-and-execute.md` 是配套讲义（模式对比、三个旋钮、参考链接），改机制时要一起改。

## 代码风格

- 全中文注释；`★` 专门标记「这里有个坑 / 这里是要带走的一句话」，新踩的坑沿用这个标记。
- ESM + 顶层 `await`（`"type": "module"`）；读同目录文件用 `fileURLToPath(import.meta.url)`，不要 `__dirname`。
- 命令输出用 `=` / `─` 分隔和缩进对齐，是课程展示效果的一部分，改动输出格式时保持这种可读性。
- 依赖变更要谨慎：`@langchain/*` 与 `@modelcontextprotocol/*` 都锁在 v1/v2 的特定写法上（见上），大版本升级会直接让 06、08 课失效。
