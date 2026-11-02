/**
 * 第 10 课：LangGraph —— 把藏起来的循环画成图
 *
 * 第 3 课你手写了 while 循环；第 8 课用 createAgent 把它藏进了一行代码，
 * 然后在尾声留了一笔债：「想加『第 3 轮必须人工确认』，得去读 middleware 文档；
 * 实在不合意，只能回去手写。」
 *
 * 这一课就是去还这笔债：用 LangGraph 的 StateGraph，把那个循环**显式地画出来**。
 * 不是换一个更高级的框架，而是把第 8 课丢掉的东西一件件拿回来：
 *
 *   · 循环长什么样，是你写出来的（节点 + 边），框架不再替你决定
 *   · 每一步之后的状态都能存下来（checkpoint），所以能停、能等、能倒带
 *   · 停下来等一个人做决定，是图里的一个函数调用（interrupt）
 *
 * ── 一张图的最小词汇表 ──
 *
 *   State      共享的「黑板」。所有节点读它，返回**增量**去改它。
 *   Node       一个 async 函数：收到 state，返回 { 要改的字段 }。
 *   Edge       「a 跑完跑 b」。条件边则是「a 跑完看 state，决定下一个是谁」。
 *   Reducer    ★ 节点返回的是增量，不是新 state。同一个字段被反复写时，
 *              用 reducer 决定怎么合并 —— 最典型的就是 messages（追加）。
 *   compile()  把 builder 变成可执行的东西。checkpointer 在这一步注入。
 *   Superstep  一轮同时执行的节点。图的循环是「一轮一轮」推进的，不是递归。
 *
 * ── 同一件事，三种写法（本课就是那第三种）──
 *
 *   第 3 课   while (true) { 调模型 → 执行工具 }          你控制每一行
 *   第 8 课   createAgent({ model, tools })               循环在框架肚子里
 *   第 10 课  StateGraph + 条件边 + tools 节点            循环是你画出来的图
 *
 * 四个 demo 里，前三个跑的仍是第 8 课那道天气题（同一套 mock 工具、同一个模型），
 * 这样你对照的只有「编排层」，不是换了一套模型。Demo 4 换回第 7 / 9 课的销售题。
 *
 * ── 四个 demo（用 argv 分档跑，别一次全跑）──
 *
 *   npm run l10         Demo 1：最小图（固定流水线，1 次 LLM 调用）
 *   npm run l10 -- 2    Demo 2：ReAct 循环图（条件边 + messages reducer）★ 本课重点
 *   npm run l10 -- 3    Demo 3：人在环里（工具执行前审批 + 中断恢复 + 倒带）
 *   npm run l10 -- 4    Demo 4：把第 9 课的 plan-execute 画成图，并跟手写版对账
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（节点返回的是增量）每个节点 return 的不是完整 state，而是「这次改了哪几个字段」。
 *      没返回的字段由它的 channel（默认 LastValue）保留旧值。第一次写的人几乎都会
 *      把整个 state 原样返回 —— 在 messages 这种带 reducer 的字段上，那就等于**重复追加**。
 *
 *   ★ 2（循环靠边回指，出口靠条件边）Demo 2 的循环不是 while，而是
 *      tools --边--> agent 这条「回指边」；什么时候退出由 agent 的条件边决定。
 *      第 3 课的 `break` 条件，就是这个路由函数的返回值。
 *
 *   ★ 3（interrupt 会让节点从头重跑）中断恢复时，LangGraph 不是从中断那一行继续，
 *      而是重新执行整个节点，让 interrupt() 这次返回 resume 值。所以 interrupt 之前的
 *      副作用（写库、发消息、扣钱）会**执行两遍**。Demo 3 的注释里把这个坑标死了。
 *
 *   ★ 4（没有 checkpointer 就没有中断）中断、恢复、记忆、倒带，全都建立在
 *      「每一步的状态被存下来」之上；MemorySaver 是存内存（进程退就没），
 *      thread_id 是「哪段历史和哪段历史是一伙的」。第 4 课那个 key 的思想，又出现了。
 *
 *   ★ 5（图不是免费的）大多数任务，第 3 课那个 while 就够了 —— 图买到的是
 *      可恢复（Demo 3）、可审查（计划是数据，Demo 4）、可编排（多角色/子图）。
 *      为这些付复杂度之前，先确认你的任务真的需要「停下来等人」或「跨进程续跑」。
 *
 * 模型、工具、问题全部沿用第 8 课：DeepSeek + ChatOpenAI + zod 版 tool()。
 */

import {
  Annotation,
  Command,
  END,
  INTERRUPT,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
} from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'

// 第 8 课那道题。Demo 1~3 都用它，好跟 08 的输出直接对照。
const QUESTION = '查一下北京和上海现在的天气，哪个城市更适合跑步？两地温差是多少摄氏度？请用计算工具算温差。'

function banner(text: string): void {
  console.log(`\n\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`)
}

function section(text: string): void {
  console.log(`\n${'─'.repeat(64)}\n${text}`)
}

// ---------- 模型与工具：跟第 8 课同一套 ----------

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
})

// ★ 同一份 mock 数据既是 Demo 1 纯函数节点用的，也是 Demo 2/3 的工具用的。
//   这样「查天气」这件事在图里只出现一次，你可以专心看编排层。
const WEATHER: Record<string, string> = {
  北京: '晴，12°C，空气质量优，风力 3 级',
  上海: '多云，18°C，空气质量良，湿度 80%',
}

const tools = [
  tool(({ city }) => {
    return JSON.stringify({ city, weather: WEATHER[city] ?? '暂无数据' })
  }, {
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    schema: z.object({ city: z.string().min(1).describe('城市名，如 北京') }),
  }),

  tool(({ expression }) => {
    // ★ 第 3 课埋的防线原样搬过来：schema 里的正则先卡住字符集，再进 new Function
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

// ★ 两个 tool() 的返回类型带着各自的 schema 泛型，`tools.find()` 拿到的是**联合类型**，
//   联合的 invoke 签名互不兼容，直接调用 TS 会报 TS2349（「不可调用」）。
//   这里收窄成「只要 name + invoke」的最小接口 —— 运行时还是原来那两个工具。
type AnyTool = {
  name: string
  invoke: (input: Record<string, unknown>) => Promise<unknown>
}

const callableTools = tools as unknown as AnyTool[]

// ================================================================
// Demo 1：最小图 —— state / node / edge / compile
// ================================================================

// ★ 先定义 state。三把「槽」：问题进来、天气写进去、答案写进去。
//   Annotation.Root 里每个字段默认是 LastValue channel ——「最后一次写入的值」。
//   所以这里**没有** reducer：谁最后写，就算谁的。
const PipelineState = Annotation.Root({
  question: Annotation<string>(),
  weather: Annotation<string>(),
  answer: Annotation<string>(),
})

async function demo1(): Promise<void> {
  banner('Demo 1：最小图 —— state / node / edge / compile')

  // ★ 节点就是普通 async 函数。第一个节点甚至不调模型 —— 纯函数也能是节点。
  //   「节点里放什么」和图无关：可以是 LLM、工具、一个 if、一个 HTTP 请求。
  // ★ 坑：节点名不能和 state 字段重名。这个节点最初叫 'answer'，撞上了 state.answer，
  //   LangGraph 直接抛 "answer is already being used as a state attribute"。
  //   所以下面改名 'compose' —— 命名空间是共用的，图在编译期就替你查重了。
  const app = new StateGraph(PipelineState)
    .addNode('fetch_weather', () => ({ weather: WEATHER['北京'] ?? '暂无数据' }))
    .addNode('compose', async (state) => {
      const res = await model.invoke([
        { role: 'system', content: '你是户外运动助手。只根据给定的天气数据回答，简短，不要编造。' },
        { role: 'user', content: `问题：${state.question}\n已知天气数据：${state.weather}` },
      ])
      // ★ 只返回 answer 一个字段。question / weather 原样留在 state 里 ——
      //   这就是「返回增量」：没提到的字段不动。
      return { answer: String(res.content) }
    })
    // 三根边：入口 → 取天气 → 回答 → 出口。顺序是**写死**的。
    .addEdge(START, 'fetch_weather')
    .addEdge('fetch_weather', 'compose')
    .addEdge('compose', END)
    .compile()

  const question = '北京现在天气怎么样？适合跑步吗？'
  console.log(`  问题：${question}`)
  console.log('  图：START → fetch_weather → compose → END（顺序是代码写死的）\n')

  const result = await app.invoke({ question })

  console.log(`  state.weather = ${result.weather}`)
  console.log(`  state.answer  = ${result.answer}`)
  console.log('  invoke 返回的是**跑完之后整个 state**，不是最后一条消息。')

  // 编译后的图可以反过来读出结构。调试图、写讲义、给同事解释时很省事。
  const graph = await app.getGraphAsync({})
  section('编译出来的图长这样（getGraphAsync 读出来的）')
  console.log(`  节点：${Object.keys(graph.nodes).join('、')}`)
  console.log(`  边：  ${graph.edges.map((e) => `${e.source} → ${e.target}`).join('、')}`)

  console.log(`
  ★ 这就是一张图的最小形态。它跟第 3 课的 while 一点都不像 —— 因为
    「先取天气再回答」这个顺序**根本不需要循环**，你以前用 while 也能写，只是浪费。
    图的真正用处要在「下一步走哪，取决于 state」时才显出来 —— 进 Demo 2。

  ★ 改造题：把 fetch_weather 拆成两个节点（get_weather → format_weather），
    再让 compose 节点读 state.weather；然后用 getGraphAsync 看边变成了几根。
    第二问：如果 compose 节点返回 { answer, weather }，weather 会被覆盖成什么？`)
}

// ================================================================
// Demo 2：ReAct 循环图 —— 条件边 + messages reducer ★ 本课重点
// ================================================================

// ★ 这里自己写 reducer，不用框架的 MessagesAnnotation / ToolNode。
//   第 8 课已经用过现成件了，这一课要把它们拆开看：reducer 到底在合并什么？
//   节点返回的是**一段增量**（一条消息或一批消息），不是新的消息数组。
type MessagesUpdate = BaseMessage | BaseMessage[]

function appendMessages(left: BaseMessage[], right: MessagesUpdate): BaseMessage[] {
  return left.concat(Array.isArray(right) ? right : [right])
}

// messages 用「追加」而不是「覆盖」：模型回一条、工具回一批，谁都不能清空历史。
// 这就是第 3 课你手写的 `messages.push(...)`，只是搬进了 channel 的 reducer 里。
const MessagesState = Annotation.Root({
  messages: Annotation<BaseMessage[], MessagesUpdate>({
    reducer: appendMessages,
    default: () => [],
  }),
})

type MessagesStateType = typeof MessagesState.State

// bindTools 告诉模型「这些工具你可以点」—— 协议是第 2 课的 tool_calls，一点没变。
const modelWithTools = model.bindTools(tools)

async function callModelNode(state: MessagesStateType) {
  const response = await modelWithTools.invoke(state.messages)
  // 返回数组而不是单条，是为了让类型表达「按 reducer 追加」这件事更直白
  return { messages: [response] }
}

async function runToolsNode(state: MessagesStateType) {
  const last = state.messages.at(-1)

  // 防御：路由函数已经保证有 tool_calls 才会进来，但节点不该依赖「上游一定对」
  if (!AIMessage.isInstance(last) || !last.tool_calls?.length) return {}

  const results: ToolMessage[] = []
  for (const call of last.tool_calls) {
    const found = callableTools.find((t) => t.name === call.name)
    // ★ 工具错误是数据：第 3 课 executeTool 的约定，在这里也一样成立。
    //   未知工具 / 执行抛错都变成一条 tool 消息回给模型，而不是让图崩掉。
    let content: string
    try {
      const output = found ? await found.invoke(call.args as Record<string, unknown>) : JSON.stringify({ error: `未知工具：${call.name}` })
      content = typeof output === 'string' ? output : JSON.stringify(output)
    } catch (e) {
      content = JSON.stringify({ error: String(e) })
    }
    // ToolMessage 必须带 tool_call_id —— 第 3 课那个「顺序错了 API 报 400」的坑，
    // 框架在类型层面帮你兜住了，但 id 对不上的话模型还是会看不懂。
    results.push(new ToolMessage({ content, tool_call_id: call.id ?? '' }))
  }
  return { messages: results }
}

// ★ 这个函数就是第 3 课 while 的出口判断：最后一条是带 tool_calls 的 AIMessage？
//   是 → 去执行工具；否 → 模型说完话了，结束。
//   区别只在于：第 3 课它是 `if`，这里它是「条件边」的返回值。
function routeAfterAgent(state: MessagesStateType) {
  const last = state.messages.at(-1)
  return AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END
}

async function demo2(): Promise<void> {
  banner('Demo 2：ReAct 循环图 —— 条件边 + messages reducer')

  // ★ 这张图的四个部件，逐一对上第 3 课：
  //   agent 节点        = 循环里第一次调模型
  //   tools 节点        = 循环里那句 for (const call of tool_calls) executeTool(...)
  //   条件边 agent→?    = `if (msg.tool_calls) continue; else break`
  //   tools → agent     = 循环体末尾的「回到开头」（循环 = 回指边）
  //   没有 checkpointer 也能跑；加上它是为了把每一步钉在 thread 上（Demo 3 要用）
  const app = new StateGraph(MessagesState)
    .addNode('agent', callModelNode)
    .addNode('tools', runToolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterAgent)
    .addEdge('tools', 'agent')
    .compile({ checkpointer: new MemorySaver() })

  const config = { configurable: { thread_id: 'demo2-react' } }

  console.log('  问题：', QUESTION)
  console.log('  图：START → agent →(有 tool_calls?)→ tools → agent → … → END\n')

  // streamMode: 'updates' 把「每一步产出的增量」交给你 —— 跟第 8 课 Demo 2 同一个口子。
  // ★ recursionLimit 是图的保险丝：这里一圈两个 superstep（agent、tools），
  //   设 12 够跑 5 轮。默认是 25 —— 相当于第 3 课的 MAX_ITERATIONS，
  //   但它是**全局步数**，不是「模型轮数」，两种计数别混。
  const stream = await app.stream(
    { messages: [new HumanMessage(QUESTION)] },
    { ...config, streamMode: 'updates', recursionLimit: 12 },
  )

  let round = 0
  // chunk 的形状是 { 节点名: 这一步的增量 } —— 节点名**是你自己起的**
  for await (const chunk of stream as AsyncIterable<Record<string, any>>) {
    for (const [node, update] of Object.entries(chunk)) {
      const produced = update?.messages
      const batch: BaseMessage[] = Array.isArray(produced) ? produced : produced ? [produced] : []

      if (node === 'agent') {
        round++
        const msg = batch.at(-1)
        const calls = AIMessage.isInstance(msg) ? (msg.tool_calls ?? []) : []
        console.log(
          calls.length
            ? `  [第 ${round} 轮] agent：模型请求工具 ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join('、')}`
            : `  [第 ${round} 轮] agent：模型给出最终回答，条件边路由到 END`,
        )
      } else if (node === 'tools') {
        for (const m of batch) {
          console.log(`            ↳ tools：工具返回 → ${String(m.content).slice(0, 100)}`)
        }
      }
    }
  }

  const state = await app.getState(config)
  section('循环结束了，看图里留下了什么')
  console.log(`  checkpoint 上的 thread_id：demo2-react`)
  console.log(`  state.messages 共 ${state.values.messages.length} 条：`)
  for (const m of state.values.messages) {
    const calls = AIMessage.isInstance(m) ? (m.tool_calls ?? []) : []
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    // 带 tool_calls 的 AI 消息 content 是空的 —— 空着显示会让人以为丢了内容
    const text = raw.trim() || (calls.length ? `[请求工具 ${calls.map((c) => c.name).join('、')}]` : '（空）')
    console.log(`    ${m.getType().padEnd(6)} | ${text.replace(/\n/g, ' ').slice(0, 70)}`)
  }
  console.log(`\n  最终回答：${String(state.values.messages.at(-1)?.content ?? '')}`)

  console.log(`
  ★ 对照第 8 课 Demo 2：那边你只能看到 'model_request' / 'tools' 这两个框架内部节点名，
    这边 'agent' / 'tools' 是你自己 addNode 起的名字 —— 你能一眼说自己画了哪几根边。
    这就是「循环在肚子里」和「循环在你手里」的区别。

  ★ 改造题：给 agent 的条件边加一个保险丝 —— 数 state.messages 里已经出现过几轮
    AIMessage.tool_calls，超过 4 轮就强制路由到 END（模仿第 3 课 MAX_ITERATIONS）。
    第二问：把这个保险丝拿掉，只靠 recursionLimit，触发时抛的是哪个错误？`)
}

// ================================================================
// Demo 3：人在环里 —— interrupt + Command(resume) + 倒带
// ================================================================

// 审批场景多一个字段：blocked。被拒绝时置 true，条件边据此直接收工。
const ApprovalState = Annotation.Root({
  messages: Annotation<BaseMessage[], MessagesUpdate>({
    reducer: appendMessages,
    default: () => [],
  }),
  blocked: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
})

type ApprovalStateType = typeof ApprovalState.State
type ApprovalDecision = 'approve' | 'reject'

// ★ 中断点放在工具执行**之前**：模型已经点了菜，但还没下单。
//   这正是第 8 课「第 3 轮必须人工确认」的通用版 —— 而且这里不需要 middleware 文档，
//   你手里就是一个普通的 if。
async function approvalToolsNode(state: ApprovalStateType) {
  const last = state.messages.at(-1)
  const calls = AIMessage.isInstance(last) ? (last.tool_calls ?? []) : []

  // ★★ 本课最容易踩的坑 ★★
  //   中断恢复时，这个节点会**从头再执行一遍**，让 interrupt() 这次返回 resume 值。
  //   所以 interrupt 之前的代码会跑两次：console.log 打两遍、写库写两条、扣钱扣两次。
  //   规矩：interrupt() 之前只做「读 state、算 payload」这种无副作用的事；
  //   有副作用的事全部放到 interrupt() 之后。
  const decision = interrupt<
    { question: string; calls: { name: string; args: Record<string, unknown> }[] },
    ApprovalDecision
  >({
    question: '模型请求执行以下工具，批准吗？',
    calls: calls.map((c) => ({ name: c.name, args: c.args })),
  })

  if (decision !== 'approve') {
    return {
      blocked: true,
      messages: [new AIMessage('（人工审批未通过：工具调用被拒绝，流程中止。）')],
    }
  }

  const results: ToolMessage[] = []
  for (const call of calls) {
    const found = callableTools.find((t) => t.name === call.name)
    const content = found ? await found.invoke(call.args as Record<string, unknown>) : JSON.stringify({ error: `未知工具：${call.name}` })
    results.push(new ToolMessage({ content: String(content), tool_call_id: call.id ?? '' }))
  }
  return { messages: results }
}

function routeAfterApprovalAgent(state: ApprovalStateType) {
  const last = state.messages.at(-1)
  return AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0 ? 'tools' : END
}

// blocked=true → 不回到模型（模型已经被拒绝一次，再让它说一句没有意义），直接收工
function routeAfterApprovalTools(state: ApprovalStateType) {
  return state.blocked ? END : 'agent'
}

function lastText(state: { messages: BaseMessage[] }): string {
  return String(state.messages.at(-1)?.content ?? '')
}

async function demo3(): Promise<void> {
  banner('Demo 3：人在环里 —— interrupt + Command(resume) + 倒带')

  // 这张图和 Demo 2 几乎一样，只换了 tools 节点 + 多一根条件边。
  const app = new StateGraph(ApprovalState)
    .addNode('agent', callModelNode)
    .addNode('tools', approvalToolsNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterApprovalAgent)
    .addConditionalEdges('tools', routeAfterApprovalTools)
    .compile({ checkpointer: new MemorySaver() })

  // ---------- 第一次：正常跑，模型要工具 → 图停住 ----------
  section('① 跑到一半停下：模型点了菜，等你批准')
  const approveConfig = { configurable: { thread_id: 'demo3-approve' } }
  const parked = await app.invoke({ messages: [new HumanMessage(QUESTION)] }, approveConfig)

  // ★ isInterrupted 是类型收窄函数：确认「这次返回的是中断，不是跑完的结果」。
  //   不检查就往下走，很容易把 { __interrupt__: [...] } 当成最终 state 用。
  if (!isInterrupted(parked)) throw new Error('预期在图里停住，但没有拿到中断 —— 模型可能直接回答了')

  for (const item of parked[INTERRUPT]) {
    const payload = item.value as { question?: string; calls?: { name: string; args: unknown }[] }
    console.log(`  中断：${payload.question ?? '（无问题）'}`)
    for (const call of payload.calls ?? []) {
      console.log(`        - ${call.name}(${JSON.stringify(call.args)})`)
    }
  }

  // ★ 中断时 checkpointer 已经把「停在 tools 节点之前」这个状态存好了。
  //   next 告诉你「恢复后第一个要跑谁」—— 这就是断点续跑的机制本身。
  const snap = await app.getState(approveConfig)
  console.log(`\n  断点：next = ${JSON.stringify(snap.next)}，state.messages 已有 ${snap.values.messages.length} 条`)

  // ---------- 恢复：把人的决定塞回去 ----------
  section('② 人批准了：用 Command({ resume }) 接着跑')
  // ★ 一次批准不一定够：模型这一轮查完天气，下一轮又要点 calculate，图会**再次中断**。
  //   真实系统里这层循环必须自己写 —— 图只负责「停住」，
  //   「谁来判断、批准几次」是你的事。
  let resumed = await app.invoke(new Command({ resume: 'approve' }), approveConfig)
  let approvals = 1
  while (isInterrupted(resumed)) {
    approvals++
    console.log(`\n  又停了一次：模型继续请求工具（这是第 ${approvals} 次审批）`)
    for (const item of resumed[INTERRUPT]) {
      const payload = item.value as { question?: string; calls?: { name: string; args: unknown }[] }
      console.log(`  中断：${payload.question ?? '（无问题）'}`)
      for (const call of payload.calls ?? []) {
        console.log(`        - ${call.name}(${JSON.stringify(call.args)})`)
      }
    }
    resumed = await app.invoke(new Command({ resume: 'approve' }), approveConfig)
  }
  console.log(`\n  一共批准了 ${approvals} 次，最终回答：${lastText(resumed)}`)
  console.log('  ★ invoked 的输入从「初始 state」变成了 Command —— 同一个 invoke，两种入口：')
  console.log('    普通输入 = 开跑；Command({ resume }) = 从断点续跑。')

  // ---------- 拒绝：不调模型，直接收工 ----------
  section('③ 人拒绝了：改道直接结束（模型不再被调用）')
  const rejectConfig = { configurable: { thread_id: 'demo3-reject' } }
  await app.invoke({ messages: [new HumanMessage(QUESTION)] }, rejectConfig)
  const rejected = await app.invoke(new Command({ resume: 'reject' }), rejectConfig)
  console.log(`  收工信息：${lastText(rejected)}`)

  // ---------- 倒带：checkpoint 历史 ----------
  section('④ 倒带：同一个 thread 的 checkpoint 历史（新 → 旧）')
  let i = 0
  for await (const snapshot of app.getStateHistory(approveConfig, { limit: 8 })) {
    const next = snapshot.next.length ? snapshot.next.join(',') : '（已结束）'
    const messages = (snapshot.values as { messages?: BaseMessage[] }).messages ?? []
    console.log(
      `  ${String(i++).padStart(2)}. next=${next.padEnd(10)} 消息 ${String(messages.length).padStart(2)} 条  最后一条：${messages.at(-1)?.getType() ?? '—'}`,
    )
  }

  console.log(`
  ★ 倒带（time travel）不是魔法：每一行都是「某个 superstep 之前存下的完整 state」。
    第 4 课你把历史存成一个数组，这里把它存成了按 thread_id 索引的 checkpoint 链；
    第 8 课那句「thread_id 把会话从一个变量变成了一个 key」，到期了。

  ★ 改造题：只对「危险工具」审批（比如名字以 delete_ 开头的），安全工具直接放行。
    提示：interrupt 可以放在条件分支里，但那样重跑时分支必须走同一条 —— 想想为什么
    （每次重跑 state 相同 → 路由相同 → 才能稳定地命中同一个 interrupt）。`)
}

// ================================================================
// Demo 4：Plan-and-Execute 图化 —— 复刻第 9 课
// ================================================================

// 同一道题、同一份 mock 数据、同一套 zod schema 和 prompt（从第 9 课原样搬来）。
// 变的只有一处：第 9 课用 for 循环 + 一堆 if 编排三个角色，这里改成三节点图。

const BASE_SALES: Record<string, number> = { 北京: 120, 上海: 150 }

// 12 个月明细，数据自洽（上月 / 去年同期算得出来）—— 第 7 课用占位值造数据吃过亏
function salesRows(city: string): string {
  const base = BASE_SALES[city] ?? 100
  const seed = city.charCodeAt(0)
  const valueAt = (month: number): number =>
    Math.round(base * (0.7 + 0.05 * month) + (((month * 37 + seed) % 23) - 11))

  const rows: string[] = []
  for (let month = 1; month <= 12; month++) {
    const value = valueAt(month)
    const lastYear = Math.round(value / (0.85 + ((month * 7 + seed) % 20) / 100))
    rows.push(
      `    {"月份":${month},"销售额":${value},"上月":${valueAt(month - 1)},"去年同期":${lastYear},"退货":${((month * 3 + seed) % 7) + 1}}`,
    )
  }
  return rows.join('\n')
}

// ★ 广州是**确定性**失败（不是随机抽风）—— 第 7/9 课同一根教学锚点，
//   逼 Replanner 去改道，而不是去重试。
function salesOf(city: string): string {
  if (city === '广州') {
    return JSON.stringify({ error: '广州数据源维护中，预计 3 天后恢复，本次无法提供数据' })
  }
  return JSON.stringify({ city, months: 12, rows: salesRows(city) })
}

function calc(expression: string): string {
  const value = new Function(`return (${expression})`)()
  return JSON.stringify({ expression, value })
}

// 计划必须结构化，参数必须是顶层字段 —— 第 9 课 ★1 的原话，这里照抄。
const PlanSchema = z.object({
  goal: z.string().describe('对目标的一句话复述'),
  steps: z
    .array(
      z.object({
        action: z.string().describe('这一步做什么，写给执行器看'),
        tool: z.enum(['get_sales', 'calculate', 'none']).describe('用哪个工具，不用工具填 none'),
        city: z.string().nullable().describe('调用 get_sales 时填城市名，否则 null'),
        expression: z.string().nullable().describe('调用 calculate 时填算式，如 "131+150"，否则 null'),
        reason: z.string().describe('为什么需要这一步'),
      }),
    )
    // 计划规模要有硬上限：一次幻觉就能排出 20 步，每一步都是真金白银
    .min(1)
    .max(6),
})
type Plan = z.infer<typeof PlanSchema>
type PlanStep = Plan['steps'][number]

// Replanner 的输出是联合类型：「继续」给修正计划，「完工」给最终回答。
// 什么时候收工是**模型的决定** —— 第 9 课 ★2，这里原样保留。
const ReplanOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('continue'),
    plan: PlanSchema.describe('修正后的**剩余**计划，不要包含已完成的步骤'),
  }),
  z.object({
    type: z.literal('finish'),
    response: z.string().describe('给用户的最终回答'),
  }),
])
type ReplanResult = z.infer<typeof ReplanOutputSchema>

const PLANNER_PROMPT =
  '你是任务规划者。把目标拆成尽量少的步骤（最多 6 步），每步必须指定用什么工具。\n' +
  '可用工具：\n' +
  '  get_sales(city) —— 查询某个城市过去 12 个月的销售明细\n' +
  '  calculate(expression) —— 计算一个纯数字算式，如 "120+150"\n' +
  '  none —— 不需要工具，纯推理或汇总\n' +
  '只输出 JSON，不要任何解释，格式：\n' +
  '{"goal":"...","steps":[{"action":"...","tool":"get_sales|calculate|none",' +
  '"city":"北京 或 null","expression":"131+150 或 null","reason":"..."}]}\n' +
  '★ city 只在 tool=get_sales 时填，expression 只在 tool=calculate 时填，其余一律 null。'

const REPLANNER_PROMPT =
  '你是重规划者。你会看到：目标、已完成的步骤及**实际结果**、以及原计划里还没执行的步骤。\n' +
  '你要做一个二选一的决定：\n' +
  '  1. 继续 —— 输出修正后的**剩余计划**（不要再包含已完成的步骤）\n' +
  '  2. 完工 —— 输出最终回答\n' +
  '只输出 JSON，两种形态之一：\n' +
  '{"type":"continue","plan":{"goal":"...","steps":[{"action":"...","tool":"...","city":null,"expression":null,"reason":"..."}]}}\n' +
  '{"type":"finish","response":"最终回答"}\n' +
  '★ 如果某步的结果是错误（比如数据源不可用），请**改道**：换数据源、调整结论口径、' +
  '或者在最终回答里明确说明这个缺口 —— 不要原样重排一个注定失败的步骤。\n' +
  '★ 只有当必要信息都拿到、或缺口确实无法弥补且已在回答里说明时，才选 finish。\n' +
  '★ 不要在回答里编造拿不到的数据。'

// ---------- 账本：这次用「真实 token」，不估了 ----------

interface Meter {
  label: string
  calls: number
  input: number
  output: number
}

function newMeter(label: string): Meter {
  return { label, calls: 0, input: 0, output: 0 }
}

// ★ 跟第 9 课的一处刻意不同：09 用 JSON.stringify().length/2 粗估**输入**，
//   这里直接读供应商返回的 usage_metadata —— 输入、输出都是**真实** token。
//   代价是两边账本口径不同，不能逐 token 对；能对的是**调用次数**和**步骤数**，
//   而这两个恰好才是编排层的指纹。
async function meteredInvoke(messages: BaseMessage[], meter: Meter): Promise<AIMessage> {
  const res = await model.invoke(messages)
  meter.calls++
  meter.input += res.usage_metadata?.input_tokens ?? 0
  meter.output += res.usage_metadata?.output_tokens ?? 0
  return res
}

// ---------- 结构化重试：第 9 课 ★3 原样搬进图里 ----------

// Planner / Replanner 都是「让模型吐 JSON」。生产里这段胶水是必须的：
// 剥 markdown 围栏 → JSON.parse → safeParse，失败就把错误回传给模型让它自己改一次。
//
// ★ 这里没用 ChatOpenAI 的 withStructuredOutput：在 deepseek-flash 的思考模式上试过三种
//   method，全部 400 —— 默认的 json_schema 不支持、functionCalling 被 tool_choice 卡住、
//   jsonMode 又要求 prompt 里出现 "json"。所以老老实实写回第 9 课这段。
//   框架帮不到你的地方，你手写过的版本就是资产。
async function jsonCall<S extends z.ZodType>(
  messages: BaseMessage[],
  schema: S,
  meter: Meter,
  label: string,
): Promise<z.infer<S>> {
  let attempt = messages
  for (let i = 0; i < 2; i++) {
    const res = await meteredInvoke(attempt, meter)
    const raw = String(res.content ?? '')
    let json: unknown
    try {
      json = JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim())
    } catch {
      json = undefined
    }
    const parsed = schema.safeParse(json)
    if (parsed.success) return parsed.data

    console.log(`    ! ${label}输出不合法，把错误回传让它自己改一次`)
    attempt = [
      ...messages,
      new AIMessage(raw.slice(0, 800)),
      new HumanMessage(
        '你上次的输出没法通过校验。请**只输出 JSON**，不要围栏、不要解释。\n' +
        `校验失败原因：${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('；')}`,
      ),
    ]
  }
  throw new Error(`${label}连续两次输出不合法，放弃`)
}

// ---------- 图的状态 ----------

interface StepRecord {
  action: string
  tool: string
  result: string
  ok: boolean
}

// plan     = 还没执行的剩余计划
// past     = 已执行步骤 + 实际结果（会一路长下去，第 9 课 ★5 的问题）
// lastKey  = 刚执行完的那份计划的指纹，用来检测「原地打转」
const PlanState = Annotation.Root({
  goal: Annotation<string>(),
  plan: Annotation<PlanStep[]>({ reducer: (_left, right) => right, default: () => [] }),
  past: Annotation<StepRecord[], StepRecord[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  replans: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  lastKey: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  finished: Annotation<boolean>({ reducer: (_left, right) => right, default: () => false }),
  finalAnswer: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  guard: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
})

type PlanStateType = typeof PlanState.State

const MAX_REPLAN = 6
const meters = {
  planner: newMeter('规划者'),
  executor: newMeter('执行器（纯代码，零 LLM 调用）'),
  replanner: newMeter('重规划者'),
}

function planKey(plan: Plan): string {
  return plan.steps.map((s) => s.action.trim().replace(/\s+/g, ' ')).join(' | ')
}

function printPlan(plan: Plan): void {
  for (const [i, step] of plan.steps.entries()) {
    const arg =
      step.tool === 'get_sales' ? `(${step.city ?? ''})` : step.tool === 'calculate' ? `(${step.expression ?? ''})` : ''
    console.log(`    ${i + 1}. [${step.tool}]${arg} ${step.action}`)
  }
}

// 三个角色各一个节点。← 这就是第 9 课 for 循环里那三坨代码的边界。
async function plannerNode(state: PlanStateType) {
  const plan = await jsonCall(
    [new SystemMessage(PLANNER_PROMPT), new HumanMessage(`目标：${state.goal}`)],
    PlanSchema,
    meters.planner,
    '规划者',
  )
  console.log(`\n  ⚙ planner 节点：给出 ${plan.steps.length} 步计划`)
  printPlan(plan)
  return { plan: plan.steps, lastKey: planKey(plan) }
}

async function executorNode(state: PlanStateType) {
  console.log('  ⚙ executor 节点：按计划逐条执行（纯代码，一次模型都不调）')
  const records: StepRecord[] = []
  for (const step of state.plan) {
    const result = step.tool === 'none' ? '（这一步不需要工具，属于推理/汇总）' : step.tool === 'get_sales' ? salesOf(step.city ?? '') : calc(step.expression ?? '0')
    const ok = !result.includes('"error"')
    records.push({ action: step.action, tool: step.tool, result, ok })
    const head = result.length > 100 ? `${result.slice(0, 100)}…（共 ${result.length} 字）` : result
    console.log(`    ${ok ? '✓' : '✗'} [${step.tool}] ${step.action}`)
    console.log(`      结果：${head}`)
  }
  return { past: records }
}

async function replannerNode(state: PlanStateType) {
  const done = state.past
    .map((s, i) => `${i + 1}. ${s.ok ? '✓' : '✗'} ${s.action}\n   结果：${s.result}`)
    .join('\n')

  const decision: ReplanResult = await jsonCall(
    [
      new SystemMessage(REPLANNER_PROMPT),
      new HumanMessage(
        `目标：${state.goal}\n\n已完成：\n${done || '（还没有）'}\n\n原计划里剩下的步骤：\n（本轮计划已执行完，请判断是继续给新计划还是完工）`,
      ),
    ],
    ReplanOutputSchema,
    meters.replanner,
    '重规划者',
  )

  if (decision.type === 'finish') {
    console.log('  ⚙ replanner 节点：宣布完工')
    return { finished: true, finalAnswer: decision.response }
  }

  const rounds = state.replans + 1
  const key = planKey(decision.plan)

  // ★ 两道护栏，跟第 9 课 ★4 一一对应：
  //   ① 计划指纹去重：改了半天给出同一份计划，继续跑只会烧钱
  //   ② MAX_REPLAN 熔断：模型永远不宣布完工时的最后一道保险
  if (key === state.lastKey) {
    console.log('  ⚙ replanner 节点：给出的计划和上一轮完全相同 → 熔断')
    return { finished: true, finalAnswer: '（重规划者给出了完全相同的计划，判定为原地打转，任务未收敛。）', guard: 'fingerprint' }
  }
  if (rounds >= MAX_REPLAN) {
    console.log(`  ⚙ replanner 节点：第 ${rounds} 次重规划，达到上限 → 熔断`)
    return { finished: true, finalAnswer: '（达到最大重规划次数，任务未收敛。）', guard: 'max-replan' }
  }

  console.log(`  ⚙ replanner 节点：给出修正计划（第 ${rounds} 次重规划）`)
  printPlan(decision.plan)
  return { plan: decision.plan.steps, lastKey: key, replans: rounds }
}

// ★ 第 9 课里这个「继续 or 收工」是 for 循环里的 if + return；
//   在这里它必须变成一根条件边 —— 因为下一站由 state 决定，不是由代码位置决定。
function routeAfterReplanner(state: PlanStateType) {
  return state.finished ? END : 'executor'
}

async function demo4(): Promise<void> {
  banner('Demo 4：Plan-and-Execute 图化 —— 复刻第 9 课')

  const app = new StateGraph(PlanState)
    .addNode('planner', plannerNode)
    .addNode('executor', executorNode)
    .addNode('replanner', replannerNode)
    .addEdge(START, 'planner')
    .addEdge('planner', 'executor')
    .addEdge('executor', 'replanner')
    .addConditionalEdges('replanner', routeAfterReplanner)
    .compile()

  const CITIES = ['北京', '上海', '广州']
  const GOAL = `对比${CITIES.join('、')}这三个城市过去一年的销售表现，指出最需要关注的城市，并给出理由。`

  console.log(`  目标：${GOAL}`)
  console.log('  （广州的数据源必然失败 —— 跟第 7 / 9 课同一个锚点，逼 replanner 处理这个缺口）')
  console.log('  图：START → planner → executor → replanner →(finished?)→ END / executor\n')

  const t0 = Date.now()
  // ★ recursionLimit 是图自带的粗保险丝（按 superstep 计），MAX_REPLAN 是业务保险丝。
  //   两层都要有：前者防「图卡死」，后者防「钱烧光」。
  const result = await app.invoke({ goal: GOAL }, { recursionLimit: 20 })

  section('最终结果')
  console.log(result.finalAnswer || '（没有最终回答）')
  if (result.guard) console.log(`\n  ! 熔断原因：${result.guard}`)

  section('账本：跟第 9 课对账')
  let totalCalls = 0
  let totalTokens = 0
  for (const m of Object.values(meters)) {
    totalCalls += m.calls
    totalTokens += m.input + m.output
    console.log(`    ${m.label.padEnd(24)} ${String(m.calls).padStart(3)} 次调用  ${String(m.input + m.output).padStart(6)} tokens`)
  }
  console.log(`    ${'合计'.padEnd(22)} ${String(totalCalls).padStart(3)} 次调用  ${String(totalTokens).padStart(6)} tokens`)
  console.log(
    `    执行了 ${result.past.length} 步，重规划（continue）${result.replans} 次，墙钟 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )
  if (result.replans === 0) {
    console.log('    注：这次模型选择直接完工，条件边的 continue 分支没被触发 —— 改道是模型的决定，不是图的保证。')
  }

  console.log(`
  ★ 对账怎么读（这是本课最该带走的一段）：
    · 第 9 课同一道题的账本是「输入 token 粗估」，这里是「真实 in/out token」——
      口径不同，**逐 token 对不上是正常的**，别硬对。
    · 能对的是调用次数：planner 1 次 + replanner N 次 + executor 0 次。
      这跟 09 课完全同构 —— 因为图没有改变算法，只改变了**编排的写法**。
    · 图买到的不是更少 token，是三样东西：计划是数据（能审查/能存库）、
      每一步都可以中断（Demo 3 的能力，这里没接）、角色边界清晰到能单测。

  ★ 改造题：把 executor 换成一个**编译好的子图**（先 new StateGraph(...).compile()，
    再 addNode('executor', 子图)），用一个 subgraph 状态字段把子图自己的 messages
    带进去。第二问：父图的 state 和子图的 state 同名时，哪边会被自动透传？`)

  console.log(`
  这一课到这里就完了。回头看第 8 课那份「代价」清单：
    循环不可改 → 现在循环就是你的代码
    人工介入要读 middleware 文档 → 现在是 interrupt + 一个 if
    出问题只能"看" → 现在能倒带、能拿 state、能改边
  框架替你付的钱，这一课你自己付了一遍 —— 所以以后再选框架，你知道账单长什么样。

  回到目录：cat README.md
  完整讲义：src/10-langgraph/langgraph.md`)
}

// ---------- 入口：用 argv 分档 ----------

if (!API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 里配置')

const which = process.argv[2] ?? '1'

if (!['1', '2', '3', '4'].includes(which)) {
  console.log(`未知档位「${which}」，可选：1（最小图）/ 2（ReAct 循环图）/ 3（人在环里）/ 4（plan-execute 图化）`)
  process.exit(1)
}

console.log('='.repeat(64))
console.log('第 10 课 LangGraph —— 把藏起来的循环画成图')
console.log('='.repeat(64))

try {
  if (which === '1') await demo1()
  else if (which === '2') await demo2()
  else if (which === '3') await demo3()
  else await demo4()
} catch (e) {
  // ★ 顶层兜底：模型输出不可信这件事，一路兜到入口（第 3 / 9 课的老规矩）
  console.log(`\n  ! 运行中断：${e instanceof Error ? e.message : String(e)}`)
  console.log('    模型输出没通过 zod 校验以外的错（命名冲突、缺 checkpointer 等）也会落到这里 ——')
  console.log('    先看原始报错，别重跑；只有「校验失败」类错误才是重跑一次通常就好。')
  process.exitCode = 1
}

if (which !== '4') {
  console.log(`\n${'='.repeat(64)}`)
  console.log('  接着看：')
  console.log('    npm run l10        最小图（state / node / edge / compile）')
  console.log('    npm run l10 -- 2   ReAct 循环图（★ 本课重点）')
  console.log('    npm run l10 -- 3   人在环里（interrupt / Command / 倒带）')
  console.log('    npm run l10 -- 4   把第 9 课画成图并对账')
}
