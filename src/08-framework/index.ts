/**
 * 第 8 课：用框架复刻前面所学（LangChain.js）
 *
 * 前 7 课你手写了 Agent 的每一个零件：HTTP 请求、工具协议、while 循环、
 * 消息历史、摘要压缩。这一课用 LangChain 把它们重写一遍。
 *
 * 目的不是"以后就用框架了" —— 而是两件事：
 *
 *   ① 验证你真的理解了。createAgent 内部就是你第 3 课写的那个 while。
 *      如果你能一眼看出"这一步对应我第 3 课的哪一行"，说明你学到手了；
 *      反过来，如果框架的某个行为让你觉得"它怎么知道要这样" ——
 *      那就是你还欠的一课，回去补。
 *
 *   ② 看清代价。框架省掉的每一行代码，都是一次"你不能再做的决定"。
 *
 * ── 对照表 ──
 *
 *   第 1 课  fetch + Bearer 头 + JSON body   →  ChatOpenAI / initChatModel
 *   第 2 课  手写 toolDefs 的 JSON Schema     →  tool(fn, { schema: zod })
 *   第 3 课  while 循环 + 出口判断            →  createAgent（循环藏在它肚子里）
 *   第 4 课  private messages: Message[]      →  checkpointer + thread_id
 *   第 4 课  compactIfNeeded 手动压缩          →  summarizationMiddleware
 *   第 1 课  手写 SSE 逐 token 打印            →  streamEvents（见 stream.ts）
 *
 * 下面四个 demo 依次运行，每个都对应前面某一课，跑的是同一个问题。
 */

import { createAgent, summarizationMiddleware, tool } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'

// 第 3 课跑过的那道题。四个 demo 都用它，好让你直接对照输出。
const QUESTION = '查一下北京和上海现在的天气，哪个城市更适合跑步？两地温差是多少摄氏度？请用计算工具算温差。'

function banner(text: string) {
  console.log(`\n\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`)
}

// ---------- 第 1 课的 fetch 去哪了 ----------

// 第 1~4 课你手写过这段（现在它被 ChatOpenAI 包进去了）：
//
//   const res = await fetch(`${BASE_URL}/chat/completions`, {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
//     body: JSON.stringify({ model: MODEL, messages, tools: toolDefs }),
//   })
//
// ★ 注意 configuration.baseURL 这个参数。DeepSeek 提供的是 OpenAI 兼容接口，
//   所以只要告诉 LangChain「按 openai 的协议打这个地址」就行。
//   这也是换模型供应商往往只改一行配置的原因 —— 协议是通用的，差异被吃掉了。
//
// （等价写法：initChatModel('deepseek-flash', { modelProvider: 'openai', baseUrl: BASE_URL })，
//   字符串版的简写，适合配置驱动的场景。这里用显式的 ChatOpenAI，对照更清楚。）

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  configuration: { baseURL: BASE_URL },
})

// ---------- 第 2/3 课的工具注册表去哪了 ----------

// 第 3 课你写了四段代码做四件事：
//   defineTool    → 把 description / schema / execute 绑在一起
//   toToolSchema  → zod schema 转成给模型看的 JSON Schema
//   toolDefs      → 生成 API 请求里的 tools 数组
//   executeTool   → 运行时两道关：JSON 能不能解析、参数合不合法
//
// tool() 把这四件事压成一次调用。★ 关键在于：里面的 zod schema 还是那个 zod，
// 你第 3 课学的东西一点没作废，只是不用再手写胶水代码了。
//
// 而 executeTool 的那两道关也没消失，只是搬进了框架内部 ——
// 代价是：校验失败时怎么处理，你不再能直接插手（后面"代价"一节细说）。

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
    // schema 里的正则已经卡住了字符集，这里只是求值
    const value = new Function(`return (${expression})`)()
    return JSON.stringify({ expression, value })
  }, {
    name: 'calculate',
    description: '计算一个数学表达式，返回数值结果',
    // ★ 第 3 课埋的防线原样搬过来：模型输出不可信，先用字符白名单卡住，
    //   别让任意 JS 进 new Function
    schema: z.object({
      expression: z
        .string()
        .regex(/^[0-9+\-*/().\s]+$/, '只允许由数字和 + - * / ( ) 组成的算式')
        .describe('数学表达式，如 (12-18)*1.8'),
    }),
  }),

  tool(() => JSON.stringify({ now: new Date().toLocaleString('zh-CN') }), {
    name: 'get_current_time',
    description: '获取当前日期和时间',
    schema: z.object({}),
  }),
]

// ================================================================
// Demo 1：最小 Agent —— 复刻第 3 课
// ================================================================

banner('Demo 1：最小 Agent（复刻第 3 课）')

// 第 3 课的 agent() 函数 40 行核心逻辑。这里 1 行。
const agent = createAgent({ model, tools })

console.log('提问：', QUESTION, '\n')
console.log('Agent 回答：\n')

const answer = await agent.invoke({
  messages: [{ role: 'user', content: QUESTION }],
})

// invoke 返回的是整个最终状态，不止最后一条消息 —— 里面躺着完整的历史
// （用户问了什么、模型点了哪些菜、工具返回了什么）。最后一条才是给用户看的。
console.log(answer.messages.at(-1)?.content)
console.log(`\n[状态里一共 ${answer.messages.length} 条消息 —— 循环的每一步都留下了痕迹]`)

// ================================================================
// Demo 2：把藏起来的循环找回来 ★ 本课重点
// ================================================================

banner('Demo 2：把藏起来的循环找回来')

// Demo 1 那 1 行里，第 3 课的 while 循环还在，只是你看不见了。
//
// 这在生产里是危险信号：Agent 跑偏的时候，你需要看到"它在第几步走错的"。
// 所以在框架里，把循环挖出来的能力比会调 API 重要得多。
//
// 框架留的口子叫 streamMode: 'updates' —— 它把"每一步的状态更新"交还给你，
// 每个 chunk 就是循环里的一次迭代。
//
// 下面这段的输出，应该和第 3 课的几乎一模一样。

const steps = await agent.stream(
  { messages: [{ role: 'user', content: QUESTION }] },
  { streamMode: 'updates' },
)

let round = 0

// chunk 的形状是 { 节点名: 这一步产生的状态更新 }。节点名 'model_request' 是"调了一次模型"，
// 'tools' 是"执行了一批工具" —— 正好对应第 3 课循环体里的两件事。
//
// 这里的 as 是信任边界：框架返回的是动态结构，编译器管不着。
// 收窄成我们约定的形状之后，后面的代码才有类型检查（和第 4 课 callModel 那行同理）
for await (const chunk of steps as AsyncIterable<Record<string, any>>) {
  for (const [node, update] of Object.entries(chunk)) {
    const produced = update?.messages
    // 状态更新有时是单条消息，有时是数组，统一成数组处理
    const batch = Array.isArray(produced) ? produced : produced ? [produced] : []

    if (node === 'model_request') {
      round++
      const msg = batch.at(-1)
      const calls = msg?.tool_calls ?? []

      if (calls.length) {
        console.log(`[第 ${round} 轮] 模型请求调用工具: ${calls.map((c: any) => c.name).join(', ')}`)
      } else {
        console.log(`[第 ${round} 轮] 模型给出最终回答，循环结束`)
      }
    } else if (node === 'tools') {
      for (const m of batch) {
        console.log(`          ↳ 工具返回 → ${String(m?.content).slice(0, 100)}`)
      }
    } else {
      // 别的节点名（比如中间件插入的步骤）也打印出来，方便你观察
      console.log(`[${node}]`, batch.length ? `${batch.length} 条消息` : update)
    }
  }
}

// ★ 对照一下第 3 课的输出：那边是你 console.log 出来的，这边是框架汇报给你的。
//   同一件事。区别在于第 3 课你随时能改循环，这里你只能"看"。

// ================================================================
// Demo 3：记忆 —— 复刻第 4 课
// ================================================================

banner('Demo 3：记忆（复刻第 4 课）')

// 第 4 课你用 `private messages: Message[] = [...]` 自己维护历史，套一个 REPL 循环
// 做多轮对话。LangChain 把这件事拆成两个概念：
//
//   checkpointer —— 历史存在哪。MemorySaver 是内存版（等于第 4 课的数组，
//                   进程一退照样没），换成数据库版就持久化了。
//   thread_id    —— 哪段历史和哪段历史是一伙的。换一个 id = 开一段新会话。
//
// ★ thread_id 这个设计值得琢磨：它把"会话"从一个变量变成了一个 key。
//   一旦历史是"按 key 取"的，它就能放进数据库、能被多个进程共享、
//   能做到"用户在手机上聊一半，电脑上接着聊"。
//   第 4 课结尾那句"下一步就是持久化"的标准答案，就是这个 key。

const memoryAgent = createAgent({
  model,
  tools,
  checkpointer: new MemorySaver(),
})

// 同一个 thread_id 贯穿两轮 —— 这就是"同一次会话"
const threadConfig = { configurable: { thread_id: 'demo-thread-1' } }

console.log('第 1 轮  你> 我叫清昼，正在学 Agent。')
await memoryAgent.invoke(
  { messages: [{ role: 'user', content: '我叫清昼，正在学 Agent。' }] },
  threadConfig,
)

const recall = await memoryAgent.invoke(
  { messages: [{ role: 'user', content: '我叫什么？在学什么？' }] },
  threadConfig,
)
console.log('第 2 轮  你> 我叫什么？在学什么？')
console.log('        Agent>', String(recall.messages.at(-1)?.content).replace(/\n/g, ' ').slice(0, 120))

// ★ 但请注意：thread_id 是 'demo-thread-1' 时它记得，换个 id 就会当场失忆。
//   框架的"记忆"从来不是模型记住了什么，而是你把哪段历史重新喂给了它 ——
//   这一点和第 4 课**一模一样**，框架没有改变本质，只是换了存取方式。

const freshThread = { configurable: { thread_id: 'demo-thread-2' } }
const amnesia = await memoryAgent.invoke(
  { messages: [{ role: 'user', content: '我叫什么？' }] },
  freshThread,
)
console.log('\n换个 thread_id 再问  你> 我叫什么？')
console.log('                    Agent>', String(amnesia.messages.at(-1)?.content).replace(/\n/g, ' ').slice(0, 100))

// ================================================================
// Demo 4：摘要压缩 —— 复刻第 4 课的 compactIfNeeded
// ================================================================

banner('Demo 4：摘要压缩（复刻第 4 课）')

// 第 4 课你手写了整套压缩机制，还踩了三个坑：
//   坑 1  切割点必须落在 user 消息上，否则 tool_calls 和它的结果会被拆散（API 报 400）
//   坑 2  一次压不够，要分档；而且要能识别"压无可压"，否则每轮白花钱
//   坑 3  工具结果长度必须单独设上限，它就在保留区里，压缩保护不到
//
// 框架的 summarizationMiddleware 把这一整套收进了一个配置对象：
//
//   trigger —— 什么时候压（tokens / messages / fraction，可用数组做"或"）
//   keep    —— 压完保留多少
//
// ★ 用之前想清楚三件事，否则它会咬你：
//   ① 压缩本身也要调模型，是要花钱的（第 4 课你为这个专门写了防线）
//   ② 阈值设小了，几轮对话就会触发，摘要反而丢细节
//   ③ 摘要生成失败时它怎么办？这个你控制不了

const compactAgent = createAgent({
  model,
  tools,
  checkpointer: new MemorySaver(),
  middleware: [
    summarizationMiddleware({
      model, // 用哪个模型做摘要（可以换成更便宜的）
      trigger: { tokens: 200 }, // demo 故意调小，几轮就能看到压缩
      keep: { messages: 2 },
    }),
  ],
})

const compactConfig = { configurable: { thread_id: 'demo-compact' } }

const turns = [
  '我叫清昼，在做一个 Agent 学习项目。',
  '这个项目用的是 TypeScript。',
  '我住在杭州，喜欢喝咖啡。',
  '我刚刚说我住在哪？',
]

for (const q of turns) {
  await compactAgent.invoke({ messages: [{ role: 'user', content: q }] }, compactConfig)

  // ★ 这个 as 不是偷懒，是框架的类型缺口：ReactAgent.getState 的类型签名写着返回 never，
  //   但运行时明明返回了完整状态（LangChain v1.5 的已知问题，实际可用）。
  //   遇到这种"类型和运行时对不上"的地方，宁可显式断言并写清楚原因，也不要一路 any 到底 ——
  //   断言至少留下一句"我知道这里有坑"的凭据。
  const state = (await compactAgent.getState(compactConfig)) as unknown as {
    values: { messages: any[] }
  }
  const history = state.values.messages

  console.log(`\n你> ${q}`)
  console.log(`   [历史 ${history.length} 条]`)
  for (const m of history) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    console.log(`     ${m.getType().padEnd(6)} | ${text.replace(/\n/g, ' ').slice(0, 64)}`)
  }
}

// ★ 两个值得盯住的细节：
//
//   ① 历史没有一直涨。涨到 5 条时压缩触发，回落到 4 条 —— 列表最上面那条
//      变成了 "Here is a summary of the conversation to date: ..."，
//      而更早的原文消失了。这就是第 4 课你手写的 compactIfNeeded 干的事。
//      压完它还能答出"我住在杭州"，说明关键信息被摘要保住了 ——
//      也正是第 4 课你写摘要提示词时反复强调的那件事。
//
//   ② 压缩后的摘要是以 **human 消息** 存进去的。而第 4 课你把摘要塞成了
//      system 消息（【之前的对话摘要】）。谁对？都对，但语义不同：
//      system 是"你给模型的指令"，human 是"用户说过的话"。
//      框架选了后者，等于对模型说"这是用户之前讲的"。这类细节框架不会告诉你，
//      却实实在在影响模型怎么理解上下文 —— 这正是"用框架要读源码"的原因。

// ================================================================
// 尾声：框架替你付了什么钱，代价是什么
// ================================================================

banner('尾声：框架的账')

console.log(`
框架替你做的（你不用再写）：
  · 循环控制、工具执行、消息拼装、格式转换
  · 参数校验失败自动回传给模型重试（第 3 课 executeTool 那两道关）
  · 历史持久化（换掉 checkpointer 就能上数据库）
  · 上下文压缩、重试、限流、人工介入 —— 这些是中间件，一行配置

代价（你不能再直接控制）：
  · 循环不再可改。想加"第 3 轮必须人工确认"，得去读 middleware 文档；
    实在不合意，只能回去手写 —— 而你现在有能力手写，这是第 3 课的价值
  · 消息格式不再是你说了算。框架有自己的 Message 类型，供应商返回的
    非标准字段会被丢掉（第 4 课你为了省 token 专门写的 toApiView 就是干这个的）
  · 出问题先要学会"把循环挖出来"（Demo 2 那个技能）。只会 invoke 的人，
    Agent 跑偏时是瞎的 —— 这是本课最该带走的技能
  · 版本在快速变。本课的 createAgent 在旧版本里叫 createReactAgent，
    住在 @langchain/langgraph/prebuilt。框架的 API 变得比你的业务快得多

所以结论不是"该用"或"不该用"，而是：

  你第 3 课写的那个 while 循环，是所有这些框架的公共内核。
  理解了它，框架对你就是"一堆可选零件"；不理解它，框架对你就是"魔法"。
  魔法能跑通 demo，但调不动、换不掉、也修不好。
`)
