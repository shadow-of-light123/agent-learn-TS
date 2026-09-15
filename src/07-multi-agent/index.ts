/**
 * 第 7 课：Multi-Agent —— 多 Agent 的价值不是"更聪明"，是"上下文隔离"
 *
 * 先说结论，因为它跟你的直觉可能是反的：
 *
 *   把一个任务拆给多个 Agent，**不会让模型变聪明**。用的是同一个模型、
 *   同一套权重，换个 system prompt 并不会凭空多出能力。
 *
 *   多 Agent 真正买到的东西只有一个：**上下文隔离**。
 *
 * 为什么隔离值钱？回到第 4 课那个问题：上下文是有限且昂贵的。
 * 一个需要调研 5 个方向的复杂任务，如果把 5 份原始材料、十几次工具调用、
 * 各种中间推理全灌进**同一个** messages 数组，会发生两件事：
 *
 *   1. 上下文膨胀 —— 越往后越贵，最后撑爆窗口
 *   2. 信号被稀释 —— 关键结论淹没在过程细节里，模型反而"抓不住重点"
 *
 * 子 Agent 的解法很朴素：给它一个**独立的 messages 数组**，让它在自己那边
 * 折腾完，**只把结论带回来**。父 Agent 的上下文里始终只有三句话，
 * 而不是三千行原始数据。
 *
 * ── 三个 demo，递进着看（★ 用命令行参数分档跑，别一次全跑）──
 *
 *   npm run l7 -- 1   单 Agent 硬扛：所有原始数据直接灌进主上下文
 *   npm run l7 -- 2   规划者 / 执行者：先出结构化计划，执行失败就重规划
 *   npm run l7        （默认）子 Agent：上下文隔离，只回传结论
 *
 * ★ 为什么分档？每个 demo 都是好几轮 LLM 调用，三次连跑又慢又烧钱。
 *   分档之后，"demo 1 对比 demo 3"这件事你可以反复跑而不用重复付费。
 *
 * ── 一个必须先说的、反直觉的实测结果 ──
 *
 *   我原本给 demo 1 预设的剧本是"单 Agent 会失焦、跑偏、忘掉原始目标"。
 *   **实测下来它没有。** 三个城市，单 Agent 全须全尾地做完了 ——
 *   而且：它自己发现广州的数据源挂了、拒绝用估计值糊弄、还主动指出了
 *   数据里对不上的字段。整个过程就是第 3 课那个 while 循环，没有任何编排。
 *
 *   所以本课的第一个结论是个**反向**结论：
 *
 *     单 Agent 的自主性比你以为的强得多。多 Agent 不是"升级版"，
 *     它只是**在特定压力下才值得付的那笔钱**。下面我们把这个压力找出来。
 *
 *   压力是什么？不是"任务复杂"，是**上下文被撑爆**。demo 1 的成本随
 *   城市数**线性增长**（原始数据全部堆在同一个数组里），而 demo 3 的父 Agent
 *   上下文**恒定**。城市越多，这个差距越大。
 *
 *   ★ 想亲眼看见曲线：`npm run l7 -- 1 8`（把城市数从 3 提到 8）。
 *     你会看到 token 数成倍地涨。至于会不会开始漏城市 —— 自己跑，别信我。
 *     跑之前先想清楚：这一次要花多少 token。
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（计划必须结构化）"规划"如果只是让模型输出一段散文，程序没法据此编排 ——
 *      你只能把散文再丢给模型让它自己看着办，那等于没规划。
 *      所以计划必须是**可校验的结构**（zod），第 3 课的 safeParse 在这里第三次派上用场。
 *
 *   ★ 2（失败要设计成确定性的）demo 2 的重规划，必须让它"推理着改计划"，
 *      而不是"重试"。如果失败只是网络抽风，重试就好了，什么都教不到。
 *      这里安排了一个**必然失败**的数据源（广州），规划者必须处理这个事实。
 *
 *   ★ 3（只回传结论）子 Agent 把过程留在自己那里 —— 这是它唯一的、也是全部的收益来源。
 *      顺带一提：这也意味着**调试变难了**，因为父 Agent 的上下文里看不到过程。
 *      真实系统要把子 Agent 的完整轨迹单独记日志，否则出了问题你无从下手。
 *
 *   ★ 4（成本要量化，不能只说"更贵"）三个 demo 都会打印 token 估算。
 *      这里有个**出乎我意料**的实测结果，也是本课第二个反直觉结论：
 *
 *          demo 1（单 Agent）：3 次调用，约 9300 tokens，主上下文 20 条消息
 *          demo 3（子 Agent）：8 次调用，约 5000 tokens，父上下文  3 条消息
 *
 *      **子 Agent 反而更便宜。** 为什么？因为朴素做法是**每一轮都把整个上下文
 *      重发一遍** —— 上下文越长，后面每一轮越贵，这是平方级的。
 *      子 Agent 各自从零开始，每个都短，加起来反而少。
 *
 *      所以"多 Agent 一定更贵"是个**错的**直觉。真实的代价在别处：
 *        · 调用次数翻倍（3 → 8）：延迟更长，出错面更大
 *        · 工程复杂度：多一层调度，多一份必须单独记录的日志
 *        · 信息有损：中间过程被丢掉了，父 Agent 想追问都无从下手
 *
 *      这些才是要权衡的东西。**别拿 token 数吓唬自己，也别拿它当借口。**
 *
 *   ★ 5（不要为了多 Agent 而多 Agent）最后会有一段诚实的结论。剧透：
 *      大多数任务"单 Agent + 一组好工具"就够了 —— 第 3 课的循环本身已经能自主决策。
 *      多 Agent 是**为了隔离上下文**才引入的，不是为了显得高级。
 */

import { z } from 'zod'

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

// ---------- token 计量（跟第 4 课同一套估算，用来把"成本"这件事量化） ----------

interface Meter {
  label: string
  calls: number
  tokens: number
}

function newMeter(label: string): Meter {
  return { label, calls: 0, tokens: 0 }
}

function estimateTokens(messages: Message[]): number {
  // 跟第 4 课一样的粗估：只求量级对，不求精确
  return Math.ceil(JSON.stringify(messages).length / 2)
}

function report(meter: Meter): string {
  return `${meter.label}：${meter.calls} 次调用，约 ${meter.tokens} tokens`
}

// ★ 每次发请求前把"这次要发多少"记进账本 —— 累计的是**输入**，
//   也就是你真正在为之付钱的那部分（而且是每轮都要重发一遍的那部分）。
async function callModel(messages: Message[], tools: unknown[], meter: Meter): Promise<AssistantMessage> {
  meter.calls++
  meter.tokens += estimateTokens(messages)

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(tools.length ? { model: MODEL, messages, tools } : { model: MODEL, messages }),
  })
  if (!res.ok) throw new Error(`API 错误 ${res.status}: ${await res.text()}`)
  return (await res.json()).choices[0].message as AssistantMessage
}

// ---------- 工具：mock 数据，但**故意造得有点大** ----------

interface Tool<S extends z.ZodType> {
  description: string
  argsSchema: S
  execute: (args: z.infer<S>) => string
}

type AnyTool = Tool<any>

function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool
}

// ★ 12 个月的明细，一个城市就有近千字。这是刻意造得"有点大"的：
//   demo 1 要让这些明细**直接灌进主 Agent 的上下文**，
//   你才能看见上下文是怎么被撑起来的、token 是怎么涨上去的。
//
//   数据是**自洽**的：上月 = 上个月的销售额，去年同期 = 真的能算出同比的那个数。
//   这不是讲究 —— 我第一次写的版本用了 `month % 3` 这种循环占位值，
//   结果模型花了一整段去质疑"两个城市的同比栏一模一样，肯定是脏数据"。
//   它没说错，但那不是本课要教的东西。**数据要经得起读，否则注意力会被带跑。**
const BASE_SALES: Record<string, number> = { 北京: 120, 上海: 150 }

function salesRows(city: string): string {
  const base = BASE_SALES[city] ?? 100
  const seed = city.charCodeAt(0) // 让各城市的数据不同，但每次运行都一样
  const valueAt = (month: number): number => Math.round(base * (0.7 + 0.05 * month) + (((month * 37 + seed) % 23) - 11))

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

const toolRegistry = {
  get_sales: defineTool({
    description: '查询某个城市过去 12 个月的销售明细',
    argsSchema: z.object({
      city: z.string().min(1).describe('城市名，如 北京 / 上海 / 广州'),
    }),
    execute: ({ city }) => {
      // ★ 确定性失败：广州的数据源**永远**是不可用的。
      //   不是网络抽风，不是随机 —— 每次跑都失败，这样 demo 2 的"重规划"
      //   才是在**推理**，而不是在**重试**（重试什么都教不到）。
      if (city === '广州') {
        return JSON.stringify({ error: '广州数据源维护中，预计 3 天后恢复，本次无法提供数据' })
      }
      return JSON.stringify({ city, months: 12, rows: salesRows(city) })
    },
  }),

  calculate: defineTool({
    description: '计算一个数学表达式，返回数值结果',
    argsSchema: z.object({
      expression: z
        .string()
        .regex(/^[0-9+\-*/().\s]+$/, '只允许由数字和 + - * / ( ) 组成的算式')
        .describe('数学表达式，如 (120+150)*2'),
    }),
    execute: ({ expression }) => {
      const value = new Function(`return (${expression})`)()
      return JSON.stringify({ expression, value })
    },
  }),
}

const registry: Record<string, AnyTool> = toolRegistry

function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

const toolDefs = Object.entries(toolRegistry).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: toToolSchema(t.argsSchema) },
}))

function executeTool(toolCall: { id: string; function: { name: string; arguments: string } }): string {
  const tool = registry[toolCall.function.name]
  if (!tool) return JSON.stringify({ error: `未知工具: ${toolCall.function.name}` })
  let raw: unknown
  try {
    raw = JSON.parse(toolCall.function.arguments)
  } catch {
    return JSON.stringify({ error: `参数不是合法 JSON: ${toolCall.function.arguments}` })
  }
  const parsed = tool.argsSchema.safeParse(raw)
  if (!parsed.success) return JSON.stringify({ error: `参数校验失败: ${parsed.error.message}` })
  try {
    return tool.execute(parsed.data)
  } catch (e) {
    return JSON.stringify({ error: String(e) })
  }
}

// ---------- 通用的 Agent 循环：主 Agent 和子 Agent 用的是**同一个函数** ----------

const MAX_ITERATIONS = 12

// ★ 注意这个函数的形状：它接收一个 **messages 数组**，而不是一个问题。
//   这就是"上下文隔离"的全部机制 —— 传进去谁的数组，它就在谁的上下文里干活。
//   子 Agent 不是什么特殊物种，它就是"用另一个数组跑同一个循环"。
async function runAgent(messages: Message[], meter: Meter, verbose = true): Promise<Message[]> {
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const msg = await callModel(messages, toolDefs, meter)
    messages.push(msg)

    if (!msg.tool_calls?.length) return messages

    for (const toolCall of msg.tool_calls) {
      const result = executeTool(toolCall)
      if (verbose) {
        console.log(`      · ${toolCall.function.name}(${toolCall.function.arguments})`)
        console.log(`        → ${result.length > 90 ? `${result.slice(0, 90)}…（共 ${result.length} 字）` : result}`)
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }
  throw new Error(`超过最大轮数 ${MAX_ITERATIONS}`)
}

function finalText(messages: Message[]): string {
  return messages.at(-1)?.content ?? ''
}

// ---------- Demo 1：单 Agent 硬扛 ----------

const GOAL = (cities: string[]): string =>
  `对比${cities.join('、')}这 ${cities.length} 个城市过去一年的销售表现，指出最需要关注的城市，并给出理由。`

// 城市池。默认只取前 3 个 —— 想看"上下文被撑爆"的样子，就加数量。
const CITY_POOL = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆', '苏州', '天津']

// demo 2 / demo 3 固定用这三个城市，好跟 demo 1 的默认跑法**直接对比**。
const CITIES = CITY_POOL.slice(0, 3)
const DEFAULT_GOAL = GOAL(CITIES)

async function demo1(count: number): Promise<void> {
  const cities = CITY_POOL.slice(0, Math.min(count, CITY_POOL.length))

  console.log('【Demo 1】单 Agent 硬扛\n')
  console.log(`  城市数：${cities.length}（用 \`npm run l7 -- 1 8\` 可以改）`)
  console.log('  所有原始数据都灌进同一个上下文，成本随城市数**线性增长**。\n')
  console.log('  ★ 说实话：这个 demo 在 3 个城市下**大概率不会失败**。')
  console.log('    我原本料定它会失焦、跑偏、忘掉目标 —— 实测它没有。')
  console.log('    它甚至能发现广州数据源挂了并拒绝编造。这正是本课第一个结论：')
  console.log('    **单 Agent 比你以为的能扛**，第 3 课那个 while 循环就是全部机关。')
  console.log('    所以要盯着看的不是"它答得好不好"，是下面那两个数字：')
  console.log('    调用次数和 token 数 —— 它们会随着城市数一路涨上去。\n')

  const meter = newMeter('主 Agent')
  const messages: Message[] = [
    { role: 'system', content: '你是数据分析助手。需要数据时调用工具，然后给出结论。' },
    { role: 'user', content: GOAL(cities) },
  ]

  const done = await runAgent(messages, meter)
  console.log(`\n  ${report(meter)}`)
  console.log(`  主上下文最终 ${done.length} 条消息`)
  console.log(`  ★ 记住这两个数字 —— demo 3 会拿它跟"父 Agent 恒定 4 条消息"做对比。`)
  console.log(`    每多一个城市，这里就多约 ${Math.round(meter.tokens / cities.length)} tokens（线性）。`)
  console.log('─'.repeat(64))
  console.log(finalText(done))
  console.log('\n  跑下一个：npm run l7 -- 2')
}

// ---------- Demo 2：规划者 / 执行者 ----------

// ★ 计划必须是**结构化**的。如果这里换成"让模型输出一段计划文字"，
//   下面 executePlan 就没法按步骤执行，只能把那段散文再丢回给模型 ——
//   那等于没有规划，只是多花了一轮钱。
// ★ 注意 expression 和 city 都是**顶层字段**，不是塞在 action 那句自然语言里。
//   第一版我把参数省了，让执行器从 action 的描述文字里正则抠数字 ——
//   结果 "基于已获取的北京12个月数据…" 被抠出个 "12"，calculate(12) 返回 12，
//   然后分析师对着这个 `{"value":12}` 愣了整整一段。
//   **计划的参数必须是结构化的。** 让模型填字段，别让程序猜散文。
const PlanSchema = z.object({
  goal: z.string().describe('对目标的一句话复述'),
  steps: z
    .array(
      z.object({
        action: z.string().describe('这一步做什么'),
        tool: z.enum(['get_sales', 'calculate', 'none']).describe('用哪个工具，不用工具填 none'),
        city: z.string().nullable().describe('调用 get_sales 时填城市名，否则 null'),
        expression: z.string().nullable().describe('调用 calculate 时填算式（如 "107+128+127"），否则 null'),
        reason: z.string().describe('为什么要做这一步'),
      }),
    )
    .min(1),
})

type Plan = z.infer<typeof PlanSchema>

async function makePlan(goal: string, known: string[], meter: Meter): Promise<Plan> {
  const context = known.length ? `\n\n已知的执行情况（请据此调整计划）：\n${known.join('\n')}` : ''
  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是任务规划者。把目标拆成尽量少的步骤，每步说明用什么工具。\n' +
        '工具：get_sales(城市名) 取原始明细；calculate(算式) 算一个纯数字表达式。\n' +
        '**只输出 JSON**，格式：\n' +
        '{"goal":"...","steps":[{"action":"...","tool":"get_sales|calculate|none",' +
        '"city":"北京 或 null","expression":"107+128 或 null","reason":"..."}]}\n' +
        '注意 city 和 expression 只在用到对应工具时才填，其余填 null。',
    },
    { role: 'user', content: `目标：${goal}${context}` },
  ]

  const raw = (await callModel(messages, [], meter)).content ?? ''

  // ★ 第 3 课 safeParse 的第三次登场：模型返回的 JSON 是**不可信输入**，
  //   结构不对就得打回去让它重来，而不是硬着头皮往下跑。
  let json: unknown
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?|```$/gm, '').trim())
  } catch {
    throw new Error(`规划者没有返回合法 JSON：${raw.slice(0, 160)}`)
  }
  const parsed = PlanSchema.safeParse(json)
  if (!parsed.success) throw new Error(`计划结构不对：${parsed.error.message}`)
  return parsed.data
}

async function demo2(): Promise<void> {
  console.log('【Demo 2】规划者 / 执行者\n')
  console.log('  先出结构化计划，再按步骤执行。')
  console.log('  广州的数据源是**必然失败**的（见 get_sales），看规划者怎么处理这个事实。\n')

  const meter = newMeter('规划者 + 执行者')
  const known: string[] = []
  const MAX_REPLAN = 2

  for (let attempt = 0; attempt <= MAX_REPLAN; attempt++) {
    const plan = await makePlan(DEFAULT_GOAL, known, meter)
    console.log(`  ${attempt === 0 ? '初始' : `第 ${attempt} 次重`}计划（${plan.steps.length} 步）：`)
    for (const [i, step] of plan.steps.entries()) {
      console.log(`    ${i + 1}. [${step.tool}] ${step.action}`)
      console.log(`       理由：${step.reason}`)
    }
    console.log()

    // 执行计划
    let failed = false
    for (const step of plan.steps) {
      if (step.tool === 'none') continue
      const args = step.tool === 'get_sales' ? { city: step.city ?? '' } : { expression: step.expression ?? '0' }
      const result = executeTool({
        id: 'plan-step',
        function: { name: step.tool, arguments: JSON.stringify(args) },
      })
      const isError = result.includes('"error"')
      console.log(`    ${isError ? '✗' : '✓'} ${step.tool}(${JSON.stringify(args)})`)
      // 屏幕上看个摘要就够了（不然刷屏），但**交给模型的必须是完整的**。
      console.log(`      → ${result.length > 100 ? `${result.slice(0, 100)}… (共 ${result.length} 字)` : result}`)

      if (isError) {
        failed = true
        // 失败信息要原样带回去 —— 规划者就是靠这句话才知道"广州拿不到"。
        known.push(`执行「${step.action}」时失败：${result}`)
        break
      }
      // ★ 这里第一版写了 `result.slice(0, 200)`，想着"省点 token"。
      //   后果是分析师只看到 3 个月的明细，于是它花了一大段抱怨"数据被截断、
      //   无法计算全年指标" —— 一个纯粹由执行器自己造成的失败。
      //   **别在执行器里偷偷截断工具结果**：要么完整给，要么明确告诉模型你截了。
      known.push(`执行「${step.action}」成功，结果：${result}`)
    }

    if (!failed) {
      console.log('\n  计划全部执行成功。')
      break
    }
    if (attempt === MAX_REPLAN) {
      console.log('\n  重规划次数用尽，带着已知情况直接出结论。')
      break
    }
    console.log('\n  ★ 撞上确定性失败 —— 交给规划者重新规划（不是重试，是改计划）\n')

    // ★ 一个必须承认的实测细节：规划者是模型，它**也会一本正经地犯蠢**。
    //   实测里它读到"3 天后恢复"，就真的排了一步"3 天后重试获取广州明细" ——
    //   而这个程序总共只运行两秒钟。
    //   这不是 bug，是"把决策交给模型"的固有代价：**计划必须被执行器兜住**。
    //   真实的规划者/执行者系统都要有一层"这步现在能不能执行"的检查，
    //   而不是拿到计划就埋头跑。
  }

  // 让规划者带着"已知情况"出最终结论（这里复用同一个模型，换个角色）
  const finalMessages: Message[] = [
    {
      role: 'system',
      content:
        '你是数据分析师。根据已知的执行情况给出结论。\n' +
        '**如果某个城市的数据拿不到，必须在结论里明确说出来，不要用估计值或常识代替。**',
    },
    { role: 'user', content: `目标：${DEFAULT_GOAL}\n\n已知执行情况：\n${known.join('\n')}` },
  ]
  const conclusion = (await callModel(finalMessages, [], meter)).content ?? ''

  console.log(`\n  ${report(meter)}`)
  console.log('─'.repeat(64))
  console.log(conclusion)
}

// ---------- Demo 3：子 Agent（上下文隔离） ----------

async function researchCity(city: string, meter: Meter): Promise<string> {
  // ★ 每个子 Agent 一个**全新的 messages 数组** —— 这就是"上下文隔离"的全部实现。
  //   那 12 行原始数据、几次工具调用、中间推理，全都留在这个数组里，
  //   函数返回时随着它一起被丢弃。回到父 Agent 的，只有下面那一句话。
  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是数据分析助手。用工具拿到数据后，**只回传两三句话的结论**，' +
        '不要把原始数据、不要把你调用了什么工具写进回答里。\n' +
        '如果数据拿不到，就直接说"数据不可用"，不要编。',
    },
    { role: 'user', content: `分析 ${city} 过去一年的销售表现，给出两三句话的结论。` },
  ]

  console.log(`    ▸ 子 Agent[${city}] 启动`)
  const done = await runAgent(messages, meter)
  const conclusion = finalText(done)
  // 把子 Agent 的消耗单独记一笔，方便对比"隔离"到底省了什么、花了什么
  console.log(`    ▸ 子 Agent[${city}] 结束（自己消化了 ${done.length} 条消息，只回传 ${conclusion.length} 字）`)
  return conclusion
}

async function demo3(): Promise<void> {
  console.log('【Demo 3】子 Agent —— 上下文隔离\n')
  console.log('  每个城市交给一个独立的子 Agent，各自用独立的 messages 数组。')
  console.log('  父 Agent 的上下文里，从头到尾只有三句话。\n')

  const parent = newMeter('父 Agent')
  const subs = newMeter('三个子 Agent（合计）')

  console.log('  阶段一：三个子 Agent 并行调研')
  const conclusions = await Promise.all(CITIES.map((c) => researchCity(c, subs)))

  console.log('\n  父 Agent 收到的全部内容（注意有多短）：')
  CITIES.forEach((c, i) => console.log(`    ${c}：${conclusions[i]}`))

  console.log('\n  阶段二：父 Agent 只基于这三句话做综合')
  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是数据分析师，负责综合下属的调研结论。\n' +
        '注意：如果有城市的结论是"数据不可用"，必须在最终回答里说明这个缺口。',
    },
    {
      role: 'user',
      content: `目标：${DEFAULT_GOAL}\n\n各城市调研结论：\n${CITIES.map((c, i) => `【${c}】${conclusions[i]}`).join('\n')}`,
    },
  ]
  const answer = (await callModel(messages, [], parent)).content ?? ''

  console.log(`\n  ${report(parent)}`)
  console.log(`  ${report(subs)}`)
  console.log(`  合计约 ${parent.tokens + subs.tokens} tokens`)
  console.log(`  ★ 父 Agent 真正发出去的上下文：${messages.length} 条消息（system + 三句结论），`)
  console.log('    对比 demo 1 那 20 条塞满原始明细的消息。父 Agent 全程一个工具都没调过。')
  console.log('─'.repeat(64))
  console.log(answer)
}

// ---------- Demo 3 的收尾：诚实的结论 ----------

function epilogue(): void {
  console.log(`\n${'='.repeat(64)}\n多说一句\n${'='.repeat(64)}`)
  console.log('  先看上面那几行 token 数 —— 你多半会以为 Demo 3 更贵。')
  console.log('  实测是反的。我跑过的几次大致是：')
  console.log('    Demo 1（单 Agent）  3 次调用，约 9300 tokens，主上下文 20 条消息')
  console.log('    Demo 3（子 Agent）  9 次调用，约 5200 tokens，父上下文  2 条消息')
  console.log('  因为 Demo 1 每一轮都要**把整个上下文重发一遍**，越长越贵；')
  console.log('  子 Agent 各自从零开始，每个都短。')
  console.log('  （具体数字每次会浮动，看量级就行。）')
  console.log()
  console.log('  所以 Demo 3 买到的是：')
  console.log('    · 父 Agent 的上下文始终只有三句话，不被原始数据污染')
  console.log('    · 三个城市可以**真并行**（Promise.all），墙钟时间更短')
  console.log('    · 单个子 Agent 跑偏，不会带偏另外两个')
  console.log('    · 顺带还更省 token —— 这条跟"多 Agent 更贵"的直觉相反，但它才是实测')
  console.log()
  console.log('  真正的代价在别处，别搞错了：')
  console.log('    · **调用次数翻倍**（3 → 9）：延迟更长，出错面更大')
  console.log('    · 中间过程不可见 —— 父 Agent 看不到子 Agent 干了什么，')
  console.log('      出问题时你得单独去翻子 Agent 的日志，否则无从下手')
  console.log('    · 信息在"只回传结论"这一步是有损的，结论写得差，父 Agent 再聪明也救不回来')
  console.log('    · 多一层间接，调试和计费都更复杂')
  console.log()
  console.log('  ★ 最后一句，也是本课最想说的：')
  console.log('    **不要为了多 Agent 而多 Agent。**')
  console.log('    第 3 课那个 while 循环已经能自主决策了 —— 加几个好工具，')
  console.log('    大多数任务单 Agent 就够，而且更好调、更好预测。')
  console.log()
  console.log('    判断标准不是"任务听起来复杂吗"，而是三个具体的问题：')
  console.log('      1. 上下文会不会被原始材料撑爆？（撑不爆就别拆）')
  console.log('      2. 子任务之间能不能真并行？（不能就别拆）')
  console.log('      3. 你愿不愿意接受"中间过程看不见"这个代价？')
  console.log('    三个都说"是"，再上编排。**先写单 Agent，别一上来就搭框架。**')
}

// ---------- 入口：用 argv 分档 ----------

if (!API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 里配置')

const which = process.argv[2] ?? '3'

console.log('='.repeat(64))
console.log(`第 7 课 Multi-Agent —— 目标`)
console.log('='.repeat(64))
console.log(`  ${DEFAULT_GOAL}`)
console.log('  （注意：广州的数据源是必然失败的，这是刻意的）\n')

if (which === '1') {
  await demo1(Number(process.argv[3]) || CITIES.length)
} else if (which === '2') {
  await demo2()
} else {
  await demo3()
  epilogue()
}

if (which !== '3') {
  console.log(`\n${'='.repeat(64)}`)
  console.log('  想接着看下一个？')
  console.log('    npm run l7 -- 2   规划者 / 执行者')
  console.log('    npm run l7        子 Agent（默认）')
}
