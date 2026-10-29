---
title: '从零手写 AI Agent：一个 while 循环撑起的九课'
date: 2026-10-20
draft: false
categories: ['AI']
tags: ['Agent', 'LLM', 'TypeScript', 'DeepSeek', 'MCP', 'RAG', 'LangChain']
---

最近把 [agent-learn](https://github.com/) 这个仓库完整跑了一遍：不用任何框架，TypeScript + Node 20 直接调 DeepSeek 的 OpenAI 兼容接口，从裸 HTTP POST 一路写到 Plan-and-Execute 三角色编排。九节课，每节课一个独立入口，依赖几乎只有 zod（直到第 8 课才引入 LangChain 做对照）。

先给出整个仓库的灵魂，也是九课反复验证的那句话：

> **Agent = LLM + 一个 while 循环 + 工具。** 模型在循环里根据对话历史决定下一步做什么，直到它不再请求工具，任务就完成了。

第 3 课写出这个循环之后，第 6 课接 MCP 时它一个字没改，第 7 课做多 Agent 时它一个字没改，第 9 课做规划编排时它还是那个循环。LangChain、Vercel AI SDK 只是把它的周边设施封装得更方便。下面按课拆解，重点讲那些**被实测推翻的直觉**和**踩过的坑**——这才是手写一遍的真正收益。

## 课程地图

| 课 | 主题 | 一句话核心 |
|---|---|---|
| 01 | Hello LLM | 调用大模型就是一个 HTTP POST，流式是手动解析 SSE |
| 02 | Tool Calling | 模型只"点菜"，执行代码的永远是你 |
| 03 | Agent Loop | while 循环 + 出口判断，所有框架的公共内核 |
| 04 | Memory | 记忆 = 全量重发历史，压缩有三个坑 |
| 05 | RAG | 朴素 RAG vs Agentic RAG 的分水岭 |
| 06 | MCP | JSON-RPC + stdio，工具变成可插拔的外部进程 |
| 07 | Multi-Agent | 多 Agent 买到的不是"更聪明"，是"上下文隔离" |
| 08 | Framework | 用 LangChain 复刻前七课，逐行对照 |
| 09 | Plan-and-Execute | Planner / Executor / Replanner 三角色与三个旋钮 |

## 01 Hello LLM：调用大模型没有任何魔法

非流式就是 `POST /chat/completions`，带 `Authorization: Bearer` 头，发一个 `{role, content}` 数组，从 `choices[0].message.content` 取结果。三种角色：`system` 定行为准则、`user` 是输入、`assistant` 是回复。

流式的请求差异只有一行 `stream: true`，响应从 JSON 变成 SSE 事件流。做过前端 SSE 渲染的话，解析逻辑完全同构：

```ts
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? '' // 留下不完整的帧，拼到下一批

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return
    const delta = JSON.parse(payload).choices[0]?.delta?.content
    if (delta) process.stdout.write(delta)
  }
}
```

两个容易忽略的点：流式取的是 `delta` 不是 `message`；一次 `read()` 可能包含不完整的帧，必须留 buffer。

## 02 Tool Calling：模型只点菜，不炒菜

最常见的误解是"模型调用了你的函数"。实际协议是五步：

1. 请求里的 `tools` 参数用 JSON Schema 描述可用函数（name / description / parameters）
2. 模型不直接回答，返回 `tool_calls: [{ id, function: { name, arguments } }]`
3. **你在本地进程里执行这个函数**
4. 结果以 `role: 'tool'`、带 `tool_call_id` 的消息塞回历史
5. 再发一次请求，模型基于结果生成自然语言回答

一个致命细节：`arguments` 是 JSON **字符串**不是对象，必须自己 `JSON.parse`，而且它是从网络过来的不可信输入。另外模型"点菜"的那条 assistant 消息要**原样**追加进历史——第 4 步回传结果时模型靠它对账，顺序错了 API 直接 400。

不需要工具的问题（"你叫什么名字"），模型会直接回答，不会硬调。

## 03 Agent Loop：所有框架的公共内核

把第 2 课的单轮调用放进循环，就是 Agent 的全部：

```ts
const MAX_ITERATIONS = 10 // 保险丝：防止模型"无限点菜"烧钱

async function agent(question: string): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: '你是一个严谨的助手，回答简洁。' },
    { role: 'user', content: question },
  ]

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const msg = await callModel(messages)

    // 出口：模型认为信息够了，不再请求工具
    if (!msg.tool_calls?.length) return msg.content

    messages.push(msg) // 先记下"点菜"，再执行
    for (const toolCall of msg.tool_calls) {
      const result = executeTool(toolCall)
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }
  throw new Error(`超过最大轮数，强制终止`)
}
```

**"何时继续、何时收工"由模型自己决定**——这就是"自主决策"的全部含义。这 40 行代码就是 LangChain `createAgent` 肚子里的东西。

本课的第二个重点是 **zod 单一数据源**。模型的参数从网络来，TypeScript 类型编译后就没了，管不住它；zod schema 是运行时真实存在的对象，一份定义同时产出三样东西：

```ts
const toolRegistry = {
  calculate: defineTool({
    description: '计算一个数学表达式',
    argsSchema: z.object({
      // 模型输出不可信，先用字符白名单卡住，别让任意 JS 进 new Function
      expression: z.string().regex(/^[0-9+\-*/().\s]+$/),
    }),
    execute: ({ expression }) => { /* ... */ },
  }),
}
// ① z.toJSONSchema(schema) → 发给模型的 JSON Schema
// ② schema.safeParse(raw)  → 运行时校验器
// ③ z.infer<typeof schema> → execute 参数的 TS 类型
```

`executeTool` 里两道关：先确认 `arguments` 是合法 JSON，再 `safeParse` 卡结构。**校验失败不抛异常，而是把失败原因作为工具结果回传给模型**——它看到具体哪里错了就能自己改对重试。这个"错误当数据回传"的模式会在第 7、9 课反复登场。

## 04 Memory：记忆是全量重发，压缩有三个坑

模型无状态，所谓记忆就是每次请求把历史全部重发。这带来两个工程问题：多轮会话要维护历史（一个 REPL + `private messages` 数组），以及上下文膨胀——需要摘要压缩，也就是 Claude Code `/compact` 的同款思路。

压缩的三个坑，每个都标了实测代价：

**坑 1：`tool_calls` 和 `role: 'tool'` 必须成对。** 裁剪历史时把这对消息拆散，API 直接报 400。解法：切割点只能落在 `user` 消息的边界上——`findCutPoint` 从后往前找 user，天然停在当前轮的第一条 user 上，绝不会切进轮子中间。

**坑 2：一次压缩可能压不动。** 如果"想保留的最近几条"本身就超预算，压完还是超。所以要两档压缩（先保最近 6 条原文，不行就只保当前轮），并且**压缩必须真的变小**——如果压完没变小，说明已压无可压，继续试就是每轮白送一次摘要调用的钱。

**坑 3：工具结果单独设上限。** 刚拿到的工具结果在"保留区"里，压缩保护不到它。一个返回 10 万字的工具能让预算形同虚设，所以 `MAX_TOOL_RESULT_CHARS` 截断是标配。截断时还要如实告知模型"原始共 N 字符"——否则它会以为拿到的是完整数据，基于残数据继续推理。

另有两个细节值得抄走：生成摘要的那次调用**不能带 tools 参数**，否则模型又开始点菜，摘要任务完成不了；估算 token 用 `JSON.stringify(messages).length / 2` 就够——它不需要精确，只需要和真实值同向变化，压缩策略就能工作。

## 05 RAG：两种接法是分水岭

流程本身朴素：切块 → embedding → 余弦相似度 → top-k。真正的工程量在"检索得准不准"，仓库专门拆了个 `explore.ts` 只跑检索层不调模型——**RAG 效果差时先分清是检索不准还是生成不行**，别急着调 prompt。

本课的落点是 RAG 怎么接进 Agent，两种接法对比：

- **朴素 RAG**：固定流程，代码触发检索一次、拼进 prompt、问一次模型。快、便宜、可预测，但检索什么由你写死，问题复杂一点就不够用
- **Agentic RAG**：把 `search_knowledge_base` 注册成工具放进第 3 课的循环，**模型自己决定要不要检索、换什么关键词、查几次**

大部分人只见过前者，就以为 RAG 是"向量库 + prompt 模板"。后者才是 Agent 时代 RAG 的常态，而它需要的全部基础设施，第 3 课就写完了。

工程上的关键变化：工具的 `execute` 从同步变成 **async**——检索要先嵌入 query，得发网络请求。这是同步签名第一次被顶破，第 6 课 MCP 会撞上同一堵墙，所有框架最后都收敛到 async 工具接口。

几个检索层细节：markdown 元信息（"来源/版权"块）对任何 query 都有一个不高不低的相似度，是纯噪音，必须 strip 掉；比 CHUNK_SIZE 短的退化块直接丢弃，否则稀释检索结果；top-k 永远返回 k 条哪怕不相关，所以要把相似度分数一起给模型看，并在 prompt 里明确"资料不足就说没提到"——**分数跨 query 本来就不可比，让模型自己判断比拍一个阈值硬卡更稳**；来源（文件名 + 标题）必须跟着正文走，溯源是 RAG 相对纯模型记忆的唯一硬优势。

## 06 MCP：把协议看穿，就三个方法

前五课的工具都是写死在 Agent 代码里的 `toolRegistry`。MCP 把工具的提供方和使用方拆成两个进程，中间走标准协议。而它本身没有任何魔法：**JSON-RPC 2.0，一行一条 JSON，走 stdin/stdout**，全程只有三个方法加一条通知：

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}   握手 + 能力协商
← {"jsonrpc":"2.0","id":1,"result":{...}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}          通知：没有 id，不能回复
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}                   拿工具清单和 JSON Schema
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{...}}    执行工具
```

新手最容易踩的坑，没有之一：**server 的 stdout 是协议通道，日志必须走 stderr**。在 server 里写一行 `console.log('服务器启动了')`，客户端就会收到一行不是 JSON 的东西，解析直接炸，而且报错完全指不到真正原因。客户端的 stdout 是你的终端可以随便打——想清楚"谁的 stdout 被当成协议用了"就通了。

两级错误的区分也值得记住：**工具自己执行失败不是协议错误**，仍然是一次成功响应，只是 `isError: true`（跟第 3 课"错误当数据回传"同一个设计）；工具名不存在才是 JSON-RPC 层的 error。

Schema 的归属在这九课里走了三步，本身就是一条主线：第 2 课**手写** JSON Schema → 第 3 课改用 **zod 生成**（schema 和实现都在自己手里）→ 到了 MCP，schema 要跨进程边界送出去，zod 对象过不去，只能退回手写/透传。结论浓缩成一句话：

> **MCP 给你的 schema，是一份你不拥有的契约。**

第 3 课能在 `executeTool` 里用 `safeParse` 亲手拦参数，因为 schema 是你的；接了 MCP 之后你拦不了——校验发生在服务端，你只能转发。这是权力的转移，也是安全问题的起点：连上别人的 server 等于交出工具执行权，而 server 还能反向向你请求 sampling 和 elicitation。

而最漂亮的一幕在 `agent.ts`：把 MCP server 的工具通过 `tools/list` 拉进注册表之后，**第 3 课那个 Agent Loop 一个字都没改**。工具从"代码的一部分"变成了"可插拔的外部依赖"。

## 07 Multi-Agent：买到的不是聪明，是隔离

这课的两个实测结果都是反直觉的，值得单独讲。

**反直觉一：单 Agent 比你以为的能扛。** demo 1 让单 Agent 硬扛三个城市的销售对比（其中广州数据源被刻意做成必然失败），预设剧本是"它会失焦、跑偏、忘掉目标"。实测它没有——自己发现广州挂了、拒绝用估计值糊弄、还主动指出数据里对不上的字段。整个过程就是第 3 课那个 while 循环，没有任何编排。所以多 Agent 不是"升级版"，是**在特定压力下才值得付的那笔钱**。压力不是"任务复杂"，是**上下文被原始数据撑爆**。

**反直觉二：子 Agent 反而更省 token。** 实测数字（量级）：

```
demo 1（单 Agent）：3 次调用，约 9300 tokens，主上下文 20 条消息
demo 3（子 Agent）：8 次调用，约 5000 tokens，父上下文  2 条消息
```

因为朴素做法每一轮都把整个上下文重发一遍，上下文越长后面每轮越贵，这是**平方级**成本；子 Agent 各自从零开始，每个都短，加起来反而少。真正的代价在别处：调用次数翻倍（延迟更长、出错面更大）、中间过程不可见（调试要单独记子 Agent 日志）、信息在"只回传结论"这一步是有损的。

而"上下文隔离"的全部机制，说出来可能会让人失望——`runAgent` 接收一个 **messages 数组**而不是一个问题：

```ts
// 传进去谁的数组，它就在谁的上下文里干活。
// 子 Agent 不是什么特殊物种，它就是"用另一个数组跑同一个循环"。
async function runAgent(messages: Message[], meter: Meter): Promise<Message[]>
```

每个子 Agent 一个全新的数组，12 行原始数据、几次工具调用、中间推理全留在里面，函数返回时随之丢弃。回到父 Agent 的只有两三句结论。父 Agent 的上下文从头到尾只有三句话，还能用 `Promise.all` 真并行。

这课还埋了三个用真金白银换来的教训：

- **计划的参数必须是顶层结构化字段。** 第一版把 `city`/`expression` 省了，让执行器从 action 描述文字里正则抠数字，结果"基于已获取的北京 12 个月数据"被抠出个 `12`，`calculate(12)` 返回 12，分析师对着 `{"value":12}` 愣了一整段
- **别在执行器里偷偷截断工具结果。** 第一版 `result.slice(0, 200)` 想省 token，分析师只看到 3 个月明细，花了一整段抱怨"数据被截断、无法计算全年指标"——一个纯粹由执行器自己造成的失败。要么完整给，要么明确告诉模型你截了
- **数据要经得起读。** mock 数据第一版用了 `month % 3` 循环占位值，模型花了一整段质疑"两个城市的同比栏一模一样，肯定是脏数据"。它没说错，但注意力全被带跑了

最后的判断标准不是"任务听起来复杂吗"，而是三个具体问题：上下文会不会被原始材料撑爆？子任务能不能真并行？你愿不愿意接受"中间过程看不见"？三个都是"是"，再上编排。**先写单 Agent，别一上来就搭框架。**

## 08 Framework：逐行对照，看清代价

用 LangChain 把前七课复刻一遍，对照表：

| 手写版 | LangChain 版 |
|---|---|
| fetch + Bearer 头 + JSON body | `ChatOpenAI`（`configuration.baseURL` 指向 DeepSeek） |
| 手写 toolDefs JSON Schema | `tool(fn, { schema: zod })` |
| while 循环 + 出口判断 | `createAgent`（循环藏在肚子里） |
| `private messages` 数组 | `checkpointer` + `thread_id` |
| `compactIfNeeded` 手动压缩 | `summarizationMiddleware` |
| 手写 SSE 逐 token 打印 | `streamEvents` |

这课最该带走的技能是 **"把藏起来的循环挖出来"**：`agent.stream(input, { streamMode: 'updates' })` 把每一步的状态更新交还给你，chunk 里的 `model_request` / `tools` 节点正好对应第 3 课循环体里的两件事。只会 `invoke` 的人，Agent 跑偏时是瞎的。

两个耐人寻味的细节：`thread_id` 把"会话"从一个变量变成了一个 key，一旦历史是按 key 取的，它就能进数据库、能跨进程共享——但换个 id 它当场失忆，框架的记忆本质还是"你把哪段历史重新喂给了它"；框架的摘要以 **human 消息**存进去，手写版用的是 system 消息，语义不同（"用户说过的话" vs "你给模型的指令"）——这类细节框架不会告诉你，却实实在在影响模型怎么理解上下文。

代价也写在明面上：循环不再可改（想加"第 3 轮必须人工确认"得去读 middleware 文档）；消息格式不由你说了算（手写版为省 token 专门剥掉 `reasoning_content` 的 `toApiView` 做不了）；版本变得比业务快（`createAgent` 以前叫 `createReactAgent`，住在另一个包里）。

## 09 Plan-and-Execute：补上"何时收工"这半个角色

第 7 课 demo 2 的 Planner/Executor 有个缺陷：它的"重规划"是**重试**（失败 → 把 known 塞回去重新出计划），"任务完成没有"由外部代码判断。这课补上 Replanner，形成闭环：

```
Planner（一次调用，结构化完整计划）
   ↓
Executor（逐步执行：纯代码 或 子 Agent 两种粒度）
   ↓
Replanner（联合类型输出：continue 给修正计划 / finish 宣布完工 —— 它自己选）
```

Replanner 的输出 schema 是本课跟第 7 课最本质的区别：

```ts
const ReplanOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('continue'), plan: PlanSchema }),
  z.object({ type: z.literal('finish'), response: z.string() }),
])
```

**"什么时候算完工"本身成了模型的决策，而不是程序里的一个 if。** 代价是模型可能过早宣布完工，所以验收条件要写进 prompt。

因为 Planner/Replanner 吐的都是 JSON 文本（可能裹着 markdown 围栏、可能少字段），需要**结构化重试**兜底：剥围栏 → `JSON.parse` → `safeParse`，失败就把错误信息回传让模型自己改一次——第 3 课 `executeTool` 那一招，原封不动搬到了规划层。另外两道护栏：计划步骤数 `max(6)` 硬上限（一次幻觉能排 20 步，每步都是真金白银）；计划指纹去重 + `MAX_REPLAN` 熔断（Replanner 有可能给出跟上一轮一模一样的计划，不管它就是烧钱的死循环）。

三个可调旋钮及实测对账：

- **执行器粒度**：纯代码（零 LLM 调用、完全可测）vs 每步一个子 Agent（临场判断，但结构化字段用不上了）。判断标准：步骤参数开局就能确定选前者，需要临场判断选后者
- **重规划时机**：每轮 replan vs 每步 replan。每步档买到"早发现"——第 2 步就注定白跑时当场改道；代价是重规划次数 ≈ 步骤数。起步从"每轮"开始，先贵后便宜是白花钱
- **past_steps**：全量原文 vs 摘要结论（长任务上它会自己膨胀，又回到第 4 课的老问题）

账要这么算：ReAct 跑十轮 = 十次满上下文的大模型调用；Plan-and-Execute = 1 次规划 + N 次执行，Executor 是纯代码时就是 **1 次大调用 + N 次零调用**。它买到的是三样东西：全局视野（计划一次成型，不会跑着跑着忘掉目标）、计划是数据（能存库、能 diff、能先给人审查再放行）、大小模型分工。

## 贯穿九课的四条主线

回头看，九课的知识不是并列的，是几条线一路贯穿：

**1. 那个循环从第 3 课活到了最后。** 第 6 课接 MCP、第 7 课做子 Agent，循环一个字没改；第 9 课的编排只是在外面套角色，执行器粒度 2 用的还是它。所有框架的 API 变来变去，内核始终是 `while + tool_calls 出口`。

**2. "模型输出不可信，错误当数据回传"。** 第 3 课 `executeTool` 校验失败回传模型重试 → 第 7 课 `makePlan` 结构化计划 → 第 9 课 `jsonCall` 结构化重试。同一招用了三次，每次都因为在跟"不可信的网络输入"打交道——跟前端在请求拦截层做参数校验是同一个直觉。

**3. 工具接口向 async 收敛。** 第 3 课同步 `(args) => string` → 第 5 课检索要发请求，第一次顶破 → 第 6 课 `callTool` 天生异步，第二次顶破。工具一旦可能涉及 IO，"同步"就是个撑不住的假设。

**4. 上下文经济学。** 第 4 课压缩（省着用）→ 第 7 课隔离（各用各的）→ 第 9 课"传结论，不传原文"（编排层复现隔离）。同一个问题三次出现，解法一次比一次前置。

## 诚实结论

这个仓库最难得的不是代码，是每课结尾那些**打自己脸的实测**：单 Agent 比你以为的能扛、子 Agent 反而更省 token、"多 Agent 更贵"是错的直觉、规划者读到"3 天后恢复"就真排一步"3 天后重试"而程序只运行两秒。

所以两句话收尾：

- **90% 的任务，一个 while 循环 + 一组好工具就够了。** 先写单 Agent，别一上来就搭框架
- 理解了那个循环，框架对你就是一堆可选零件；不理解，框架对你就是魔法。**魔法能跑通 demo，但调不动、换不掉、也修不好**
