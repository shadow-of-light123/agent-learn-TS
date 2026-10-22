/**
 * 第 9 课：Plan-and-Execute —— 先想清楚，再动手
 *
 * 第 3 课那个 while 循环（ReAct）是**走一步看一步**：每一轮都问模型「下一步干嘛」。
 * 它的病在**全局视野 = 当前 messages 数组**：
 *   · 任务一长，上下文被工具结果灌满（第 4 课的问题），模型开始在细节里打转
 *   · 每一轮都要把全部历史重发一遍 —— 第 N 轮的输入 ≈ 前 N-1 轮之和，**平方级**成本
 *
 * Plan-and-Execute 把「想」和「做」拆成两个独立环节：
 *
 *     Planner    一次调用，产出**结构化的完整计划**
 *     Executor   按计划逐步执行（纯代码 / 子 Agent 两种粒度）
 *     Replanner  拿着执行中学到的新事实，修正剩余计划，或宣布完工
 *
 * ── 本课补的是第 7 课缺的那半个角色 ──
 *
 * 第 7 课 demo 2（规划者/执行者）有 Planner、有 Executor，但**没有 Replanner**：
 *   · 它的"重规划"是「失败 → 把 known 塞回去重新 makePlan」—— 是**重试**，不是**改道**
 *   · "任务完成没有"由外部代码判断（结尾另叫了一轮"数据分析师"出结论）
 * 本课把这两件事都交给模型：Replanner 的输出是一个**联合类型**，
 * "continue（给修正计划）/ finish（给最终回答）"由它自己选。
 *
 * 同一道题（对比北京/上海/广州，广州数据源必然失败），你可以跟 07 课 demo 2 直接对照。
 *
 * ── 三个 demo（★ 每个都是多轮 LLM 调用，用参数分档跑，别一次全跑）──
 *
 *   npm run l9        （默认）完整三角色：Planner → Executor(纯代码) → Replanner
 *   npm run l9 -- 2   换**执行器粒度**：每步丢给一个子 Agent，然后跟 demo 1 对账
 *   npm run l9 -- 3   换**重规划时机**：每步都 replan，然后跟 demo 1 对账
 *
 * demo 2 / demo 3 各自都会真的跑一遍对照，所以它们**自包含**：单跑一个也能看到结论。
 *
 * ── 三个旋钮（比代码本身重要，第 5 节详述）──
 *
 *   重规划时机   每轮（计划跑完）/ 每步（执行一步就问一次）
 *   执行器粒度   纯代码（零 LLM 调用）/ 子 Agent（临场判断）
 *   past_steps   全量原文 / 摘要结论
 *
 * ── 本课要盯住的几个点（★）──
 *
 *   ★ 1（计划必须结构化）"规划"如果只是让模型输出一段散文，程序没法据此编排 ——
 *      你只能把散文再丢回给模型让它自己看着办，那等于没规划，只是多花一轮钱。
 *      所以计划必须是**可校验的结构**（zod），第 3 课 safeParse 的第四次登场。
 *      更要命的是参数：city / expression 必须是**顶层字段**。第 7 课我把参数省了，
 *      让执行器从 action 文字里正则抠数字，结果抠出个 "12" —— 教训在那儿写着。
 *
 *   ★ 2（Replanner 输出联合类型）这是本课跟 07 课 demo 2 最大的差别。
 *      "什么时候算完工"本身成了**模型的决策**，而不是程序里的一个 if。
 *      代价是：模型可能过早宣布完工。所以 finish 的分支要写进 prompt 的验收条件里。
 *
 *   ★ 3（模型输出不可信，要有兜底）Planner/Replanner 吐的都是 JSON 文本，
 *      可能裹着 markdown 围栏、可能少个字段。这里做的是**结构化重试**：
 *      safeParse 失败就把错误信息回传给模型让它自己改一次 ——
 *      第 3 课 executeTool「校验失败回传模型重试」那一招，在规划层同样适用。
 *
 *   ★ 4（计划会原地打转）Replanner 是有可能给出跟上一轮一模一样的计划的。
 *      不管它，你就得到一个烧钱的死循环。护栏有两道：计划去重检测 + MAX_REPLAN 熔断。
 *
 *   ★ 5（past_steps 会膨胀）执行结果全量塞给 Replanner，长任务上就是第 4 课那个老问题。
 *      本课的量级还扛得住（每次都是本地工具、结果两三百字），但代码里把
 *      「传结论，不传原文」这条原则标注出来了 —— 它是 07 课「只回传结论」的放大版。
 *
 *   ★ 6（粒度 2 和「每步 replan」天然冲突）并行执行一批步骤时，你没法在批次中间
 *      插决策。想要「每步 replan」就必须串行。这也是为什么真正的 DAG 调度
 *      （无依赖步骤 Promise.all）通常配的是「每轮 replan」。
 *
 *   ★ 7（老实说）90% 的任务，第 3 课那个 while 循环 + 一组好工具就够了。
 *      Plan-and-Execute 买到的是「全局视野 + 计划可审查 + 大小模型分工」，
 *      为这些付三倍工程复杂度之前，先确认你真的需要它们。
 *
 * 工具的写法跟第 3~7 课保持一致：zod 单一定义（JSON Schema + 运行时校验 + TS 类型）。
 */

import { z } from 'zod'

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const API_KEY = process.env.DEEPSEEK_API_KEY
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'

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

// ---------- token 计量（跟第 4 / 7 课同一套估算，用来把"成本"量化） ----------

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

// ★ 每次发请求前把"这次要发多少"记进账本 —— 累计的是**输入**，
//   也就是你真正在为之付钱、而且是每轮都要重发一遍的那部分。
//   （本课不用第 7 课那个 report()，改成 printAccounts 一行一列地对账，看得更清。）
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

// ---------- 工具层：跟第 7 课同一套 mock 数据 ----------

interface Tool<S extends z.ZodType> {
  description: string
  argsSchema: S
  execute: (args: z.infer<S>) => string
}

type AnyTool = Tool<any>

function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool
}

const BASE_SALES: Record<string, number> = { 北京: 120, 上海: 150 }

// 12 个月的明细，一个城市近千字。数据是**自洽**的（上月 / 去年同期真的算得出来）——
// 第 7 课那个用循环占位值造数据的版本，模型花了一整段去质疑脏数据，
// 注意力全被带跑了。数据要经得起读。
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
      // ★ 确定性失败：广州的数据源**永远**不可用。不是网络抽风、不是随机 ——
      //   每次跑都失败，这样 Replanner 才是在**推理着改道**，而不是在**重试**。
      //   重试什么都教不到（第 7 课就是这么设计的，这里沿用同一份数据）。
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

// ---------- ReAct 循环：只有「粒度 2」的执行器才需要它 ----------

const MAX_ITERATIONS = 8

// 跟第 3 / 7 课同一个循环。它接收一个 **messages 数组** ——
// 传进去谁的数组，它就在谁的上下文里干活。子 Agent 就是这么来的。
async function runAgent(messages: Message[], meter: Meter, verbose = true): Promise<Message[]> {
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const msg = await callModel(messages, toolDefs, meter)
    messages.push(msg)

    if (!msg.tool_calls?.length) return messages

    for (const toolCall of msg.tool_calls) {
      const result = executeTool(toolCall)
      if (verbose) {
        const short = result.length > 90 ? `${result.slice(0, 90)}…（共 ${result.length} 字）` : result
        console.log(`        · ${toolCall.function.name}(${toolCall.function.arguments}) → ${short}`)
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }
  throw new Error(`子 Agent 超过最大轮数 ${MAX_ITERATIONS}`)
}

function finalText(messages: Message[]): string {
  return messages.at(-1)?.content ?? ''
}

// ---------- 计划的两张 Schema ----------

// ★ 计划必须是**结构化**的，且参数必须是顶层字段。
//   如果这里换成"让模型输出一段计划文字"，下面的执行器就没法按步骤编排，
//   只能把那段散文再丢回给模型 —— 那等于没有规划。第 7 课的 "12" 就栽在这。
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
    // ★ 上限定成 6 不是随便定的：一次幻觉就能让规划者排出 20 步，
    //   而每一步都是真金白银。**计划规模要有硬上限**，这跟第 4 课给工具结果设长度上限同理。
    .min(1)
    .max(6),
})
type Plan = z.infer<typeof PlanSchema>
type PlanStep = Plan['steps'][number]

// ★ Replanner 的输出是个**联合类型**：要么给修正后的剩余计划，要么宣布完工。
//   这是跟第 7 课 demo 2 最本质的区别 —— 那边的"重规划"永远产出新计划，
//   完成与否由外部代码判断；这里"何时收工"本身是模型的决策。
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

// ---------- ★ 3：结构化重试 —— 把"模型输出是文本"这件事兜住 ----------

// Planner 和 Replanner 都是"让模型吐 JSON"。生产里这段胶水是必须的：
// 剥 markdown 围栏 → JSON.parse → safeParse，失败就把**错误信息回传给模型**让它自己改一次。
// 这跟第 3 课 executeTool 校验失败回传模型重试是同一招，只是搬到了规划层。
async function jsonCall<S extends z.ZodType>(
  messages: Message[],
  schema: S,
  meter: Meter,
  label: string,
): Promise<z.infer<S>> {
  let attempt: Message[] = messages
  for (let i = 0; i < 2; i++) {
    const raw = (await callModel(attempt, [], meter)).content ?? ''
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
      { role: 'assistant', content: raw.slice(0, 800) },
      {
        role: 'user',
        content:
          '你上次的输出没法解析，请**只输出 JSON**，不要围栏、不要解释。\n' +
          `校验失败原因：${parsed.success ? '' : parsed.error.message}\n` +
          `输出内容（前 800 字）：${json === undefined ? '不是合法 JSON' : ''}`,
      },
    ]
  }
  throw new Error(`${label}连续两次输出不合法，放弃`)
}

// ---------- ① Planner：一次调用，拿到全局方案 ----------

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

async function makePlan(goal: string, meter: Meter): Promise<Plan> {
  return jsonCall([{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: `目标：${goal}` }], PlanSchema, meter, '规划者')
}

// ---------- ② Executor：两种粒度 ----------

type Executor = 'direct' | 'sub-agent'

// 粒度 1：纯代码直接执行（第 7 课 demo 2 的做法，**零 LLM 调用**）
// 计划里已经写明了 tool + args，执行器就只是个查表调用。快、免费、完全可测。
function executeStepDirect(step: PlanStep): string {
  if (step.tool === 'none') return '（这一步不需要工具，属于推理/汇总）'
  const args = step.tool === 'get_sales' ? { city: step.city ?? '' } : { expression: step.expression ?? '0' }
  return executeTool({ id: 'plan-step', function: { name: step.tool, arguments: JSON.stringify(args) } })
}

// 粒度 2：把这一步丢给一个带工具的 ReAct 子 Agent，让它自己去跑
// ★ 注意：子 Agent 拿到的是 action 那句自然语言，**city/expression 这些结构化字段用不上**。
//   这等于放弃了「计划可审查」的一部分收益 —— 你只能审"它要干嘛"，审不了"它会怎么干"。
//   只有步骤本身真的需要临场判断（"分析这个城市的趋势"要调几次工具说不准）才值得。
async function executeStepAsAgent(step: PlanStep, meter: Meter, verbose: boolean): Promise<string> {
  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是执行者，负责完成给定的**单个**步骤。用工具拿到需要的数据，' +
        '然后**只回传两三句话的结论**，不要把原始数据、调用了什么工具写进回答。\n' +
        '如果数据拿不到，就直接说"数据不可用"，不要编。',
    },
    { role: 'user', content: step.action },
  ]
  if (verbose) console.log(`      ▸ 子 Agent 启动：${step.action}`)
  const done = await runAgent(messages, meter, verbose)
  const conclusion = finalText(done)
  if (verbose) console.log(`      ▸ 子 Agent 结束（自己消化了 ${done.length} 条消息，只回传 ${conclusion.length} 字）`)
  // ★ 只回传结论 —— 那 12 行原始明细、几次工具调用，全都留在子 Agent 自己的数组里，
  //   函数返回时随它一起被丢弃。这是第 7 课「上下文隔离」的全部机制。
  return conclusion
}

async function executeStep(step: PlanStep, executor: Executor, meter: Meter, verbose: boolean): Promise<string> {
  return executor === 'direct' ? executeStepDirect(step) : executeStepAsAgent(step, meter, verbose)
}

// ---------- ③ Replanner：本课新增的半个角色 ----------

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

interface StepRecord {
  action: string
  result: string
  ok: boolean
}

async function replan(goal: string, past: StepRecord[], remaining: PlanStep[], meter: Meter): Promise<ReplanResult> {
  // ★ 5（见文件头）：past_steps 全量塞进来。短任务没问题，长任务上它自己也会膨胀 ——
  //   那时候就该按第 4 课的办法，把每步结果先压成一句话再传。
  //   原则是「传结论，不传原文」：Replanner 不需要重看那 900 字明细。
  const done = past.map((s, i) => `${i + 1}. ${s.ok ? '✓' : '✗'} ${s.action}\n   结果：${s.result}`).join('\n')
  const left = remaining.length ? remaining.map((s) => `- [${s.tool}] ${s.action}`).join('\n') : '（无，已到计划末尾）'

  const messages: Message[] = [
    { role: 'system', content: REPLANNER_PROMPT },
    {
      role: 'user',
      content: `目标：${goal}\n\n已完成：\n${done || '（还没有）'}\n\n原计划里剩下的步骤：\n${left}`,
    },
  ]
  return jsonCall(messages, ReplanOutputSchema, meter, '重规划者')
}

// ---------- ④ 主循环：Plan → Execute → Replan ----------

const MAX_REPLAN = 6 // ★ 4（见文件头）：熔断保险丝，防止 Replanner 无限改计划
const PAST_CHARS_WARN = 4000 // ★ 5（见文件头）：past_steps 膨胀到多少字，就在屏幕上提醒你该摘要了

type ReplanTiming = 'per-round' | 'per-step'

interface RunOptions {
  executor: Executor
  timing: ReplanTiming
  verbose?: boolean
}

interface RunResult {
  answer: string
  meters: Meter[]
  steps: number
  replans: number
  pastChars: number
  wallMs: number
}

// 给计划拍个指纹，用来检测"Replanner 原地打转"
function planKey(plan: Plan): string {
  return plan.steps.map((s) => s.action.trim().replace(/\s+/g, ' ')).join(' | ')
}

async function planAndExecute(goal: string, opts: RunOptions): Promise<RunResult> {
  const verbose = opts.verbose ?? true
  const plannerMeter = newMeter('规划者')
  const executorMeter = newMeter(opts.executor === 'direct' ? '执行器（纯代码，零调用）' : '执行器（子 Agent）')
  const replannerMeter = newMeter('重规划者')

  const t0 = Date.now()
  const past: StepRecord[] = []
  let steps = 0
  let replans = 0
  let pastChars = 0
  let lastKey = ''

  let plan = await makePlan(goal, plannerMeter)
  if (verbose) {
    console.log(`  初始计划（${plan.steps.length} 步）：`)
    printPlan(plan)
  }

  // outer 标签是为了「每步 replan」档：拿到新计划后要整个重新开始内层循环，
  // 而不是继续跑旧计划剩下的步骤。
  outer: for (let round = 0; round <= MAX_REPLAN; round++) {
    const key = planKey(plan)
    // ★ 4（见文件头）：Replanner 有可能会给出跟上一轮一模一样的计划。不管它，你就得到了
    //   一个烧钱的死循环。熔断 + 明确的告警，比"跑着看"强。
    if (key === lastKey) {
      console.log('\n  ★ 熔断：重规划者给出了跟上一轮完全相同的计划，继续跑只会原地打转。')
      break
    }
    lastKey = key

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      const result = await executeStep(step, opts.executor, executorMeter, verbose)
      steps++
      const ok = !result.includes('"error"')
      past.push({ action: step.action, result, ok })
      pastChars += result.length

      const head = result.length > 100 ? `${result.slice(0, 100)}…（共 ${result.length} 字）` : result
      console.log(`    ${ok ? '✓' : '✗'} [${step.tool}] ${step.action}`)
      console.log(`      结果：${head}`)

      if (!ok) {
        // ★ 别在执行器里偷偷截断工具结果 —— 第 7 课为此吃过教训（分析师只拿到 3 个月明细，
        //   于是花了一整段抱怨"数据被截断"）。要么完整给，要么明确告诉模型你截了。
        console.log('      （失败信息会原样带回给重规划者，它就是靠这句话才知道要改道）')
      }

      if (opts.timing === 'per-step') {
        replans++
        const decision = await replan(goal, past, plan.steps.slice(i + 1), replannerMeter)
        console.log(`      ↳ 重规划者（执行 ${i + 1} 步后）：${decision.type === 'finish' ? '宣布完工' : '给出修正计划'}`)
        if (decision.type === 'finish') {
          return finish(decision.response, [plannerMeter, executorMeter, replannerMeter], steps, replans, pastChars, t0)
        }
        plan = decision.plan
        if (verbose) printPlan(plan)
        continue outer // 换上新计划，重新开始
      }
    }

    if (opts.timing === 'per-round') {
      replans++
      const decision = await replan(goal, past, [], replannerMeter)
      console.log(`\n  ↳ 重规划者（本轮计划跑完）：${decision.type === 'finish' ? '宣布完工' : '给出修正计划'}`)
      if (decision.type === 'finish') {
        return finish(decision.response, [plannerMeter, executorMeter, replannerMeter], steps, replans, pastChars, t0)
      }
      plan = decision.plan
      if (verbose) printPlan(plan)
    }
  }

  // 熔断后也要给用户一个交代 —— 这是"把决策交给模型"必须配的兜底。
  return finish('（重规划次数用尽或检测到原地打转，任务未收敛。）', [plannerMeter, executorMeter, replannerMeter], steps, replans, pastChars, t0)
}

function printPlan(plan: Plan): void {
  for (const [i, step] of plan.steps.entries()) {
    const arg = step.tool === 'get_sales' ? `(${step.city ?? ''})` : step.tool === 'calculate' ? `(${step.expression ?? ''})` : ''
    console.log(`    ${i + 1}. [${step.tool}]${arg} ${step.action}`)
  }
}

function finish(
  answer: string,
  meters: Meter[],
  steps: number,
  replans: number,
  pastChars: number,
  t0: number,
): RunResult {
  if (pastChars > PAST_CHARS_WARN) {
    console.log(`\n  ! past_steps 已累计 ${pastChars} 字 —— 再长就该按第 4 课的办法摘要压缩了。`)
  }
  return { answer, meters, steps, replans, pastChars, wallMs: Date.now() - t0 }
}

function printAccounts(result: RunResult): void {
  let total = 0
  for (const m of result.meters) {
    total += m.tokens
    console.log(`    ${m.label.padEnd(22)} ${String(m.calls).padStart(3)} 次调用  ${String(m.tokens).padStart(6)} tokens`)
  }
  console.log(`    ${'合计'.padEnd(22)} ${String(result.meters.reduce((a, m) => a + m.calls, 0)).padStart(3)} 次调用  ${String(total).padStart(6)} tokens`)
  console.log(`    执行了 ${result.steps} 步，重规划 ${result.replans} 次，past_steps 累计 ${result.pastChars} 字，墙钟 ${(result.wallMs / 1000).toFixed(1)}s`)
}

// ---------- 目标：跟第 7 课 demo 2 同一道题 ----------

const CITIES = ['北京', '上海', '广州']
const GOAL = `对比${CITIES.join('、')}这三个城市过去一年的销售表现，指出最需要关注的城市，并给出理由。`

function runHeader(title: string): void {
  console.log(`\n${'='.repeat(64)}`)
  console.log(title)
  console.log('='.repeat(64))
}

// ---------- Demo 1：完整三角色（粒度 1，每轮 replan） ----------

async function demo1(): Promise<RunResult> {
  runHeader('【Demo 1】完整三角色：Planner → Executor(纯代码) → Replanner')
  console.log('  执行器用纯代码（零 LLM 调用），每轮计划跑完 replan 一次。')
  console.log('  ★ 盯住两处：广州那步失败后，Replanner 是**怎么改道**的；')
  console.log('    以及最后那句"完工"是它自己宣布的，不是外面代码判断的。\n')

  const result = await planAndExecute(GOAL, { executor: 'direct', timing: 'per-round' })
  console.log(`\n${'─'.repeat(64)}`)
  console.log(result.answer)
  console.log(`\n  账本：`)
  printAccounts(result)
  return result
}

// ---------- Demo 2：换执行器粒度 ----------

async function demo2(): Promise<void> {
  runHeader('【Demo 2】换执行器粒度：每步一个子 Agent')
  console.log('  计划里每一步的 action 丢给一个带工具的 ReAct 子 Agent，让它自己临场决定怎么干。')
  console.log('  ★ 代价先想清楚：调用次数会涨，而且结构化字段（city/expression）用不上了。\n')

  const sub = await planAndExecute(GOAL, { executor: 'sub-agent', timing: 'per-round' })
  console.log(`\n${'─'.repeat(64)}`)
  console.log(sub.answer)
  console.log(`\n  账本（粒度 2）：`)
  printAccounts(sub)

  runHeader('同一道题，换成粒度 1（纯代码）再跑一遍 —— 直接对账')
  const direct = await planAndExecute(GOAL, { executor: 'direct', timing: 'per-round', verbose: false })
  console.log(`\n  账本（粒度 1）：`)
  printAccounts(direct)

  console.log(`\n  ★ 对照：`)
  console.log(`    粒度 1  纯代码执行，执行器 0 次 LLM 调用，${direct.steps} 步全部同步跑完`)
  console.log(`    粒度 2  子 Agent 执行，执行器多花了 ${sub.meters[1].calls} 次调用，墙钟 ${(sub.wallMs / 1000).toFixed(1)}s vs ${(direct.wallMs / 1000).toFixed(1)}s`)
  console.log(`    ★ 但粒度 2 换来的东西是真的：子 Agent 自己决定调几次工具、失败了自己重试，`)
  console.log(`      父层（Replanner）拿到的 past_steps 还更短（${sub.pastChars} 字 vs ${direct.pastChars} 字）—— 因为子 Agent 只回传结论。`)
  console.log(`      这就是第 7 课「上下文隔离」在编排层的复现。`)
  console.log(`    ★ 选哪档看这个判断：步骤的参数开局就能确定 → 粒度 1；步骤需要临场判断 → 粒度 2。`)
}

// ---------- Demo 3：换重规划时机 ----------

async function demo3(): Promise<void> {
  runHeader('【Demo 3】换重规划时机：每步都 replan')
  console.log('  每执行一步就问一次 Replanner「计划要不要改」。')
  console.log('  ★ 直觉上它会更强，账单上它会更贵 —— 重规划次数 ≈ 步骤数。\n')

  const perStep = await planAndExecute(GOAL, { executor: 'direct', timing: 'per-step' })
  console.log(`\n${'─'.repeat(64)}`)
  console.log(perStep.answer)
  console.log(`\n  账本（每步 replan）：`)
  printAccounts(perStep)

  runHeader('同一道题，换成每轮 replan 再跑一遍 —— 直接对账')
  const perRound = await planAndExecute(GOAL, { executor: 'direct', timing: 'per-round', verbose: false })
  console.log(`\n  账本（每轮 replan）：`)
  printAccounts(perRound)

  console.log(`\n  ★ 对照：`)
  console.log(`    每步 replan  ${perStep.replans} 次重规划，${perStep.meters[2].tokens} tokens`)
  console.log(`    每轮 replan  ${perRound.replans} 次重规划，${perRound.meters[2].tokens} tokens`)
  console.log(`    ★ 每步档买到的是「早发现」：第 2 步就注定白跑时，它当场就改道了，`)
  console.log(`      不用把整份计划跑完。代价是重规划调用次数≈步骤数。`)
  console.log(`    ★ 第三种档位是第 7 课 demo 2 的「失败才重规划」：最省，但学不到执行中的新机会。`)
  console.log(`    ★ 起步建议：从「每轮」开始。等你在自己的任务上真的看到"某步注定白跑"的浪费，`)
  console.log(`      再往「每步」加。反过来降级很容易，先贵后便宜是白花钱。`)
}

// ---------- 尾声 ----------

function epilogue(): void {
  console.log(`\n${'='.repeat(64)}\n多说一句\n${'='.repeat(64)}`)
  console.log('  跑完三个 demo，你应该拿到一张自己的账本了。第一件事是承认它的量级：')
  console.log('    · 粒度 1 那两档，成本主要在 Planner 和 Replanner —— 各一次调用，都很小')
  console.log('    · 真正会涨的是「每步 replan」和「每步子 Agent」，两个旋钮会相乘')
  console.log('  所以别一次把两个都开到最大档。**先跑最便宜的那档，看它哪里不够，再升一级。**')
  console.log()
  console.log('  再说一遍本课最重要的一条（第 7 课也说过，这里换个角度）：')
  console.log('    **Plan-and-Execute 通常不省总 token，它省的是「贵模型的调用次数」和「决策质量」。**')
  console.log('    ReAct 跑十轮 = 十次满上下文的大模型调用；')
  console.log('    Plan-and-Execute = 1 次规划 + N 次执行。如果你的 Executor 是纯代码，')
  console.log('    这就是 1 次大调用 + N 次零调用 —— 账要这么算。')
  console.log()
  console.log('  它买到的东西，说清楚只有三样：')
  console.log('    1. **全局视野** —— 计划是一次成型的，不会跑着跑着忘掉原始目标')
  console.log('    2. **计划是数据** —— 能存库、能 diff、能先给人审查再放行。')
  console.log('       这是 ReAct 做不到的：ReAct 的"计划"散在每轮决策里，没法截获')
  console.log('    3. **大小模型分工** —— Planner 用强的，Executor 用便宜的，甚至不用模型')
  console.log()
  console.log('  什么时候**别用**：')
  console.log('    · 两三步的小任务 —— ReAct 一轮就过去了，先规划反而多花一次调用 + 更高延迟')
  console.log('    · 计划完全取决于执行反馈（探索式调试、对话式交互）—— 每步都推翻，replan 的钱全白花')
  console.log('    · ★ 老实说：**90% 的任务，第 3 课那个 while 循环 + 一组好工具就够了。**')
  console.log('      先写单 Agent，别一上来就搭编排。')
  console.log()
  console.log('  ── 再往前走的两步 ──')
  console.log('    ① 从链到 DAG：让 Planner 直接输出依赖边（LLMCompiler, Kim et al. 2024），')
  console.log('       无依赖的步骤 Promise.all 真并行 —— 第 7 课 demo 3 的并行收益在这里继承。')
  console.log('       ★ 但记住 ★ 6：并行批次里插不进决策，"每步 replan"和 DAG 天生互斥。')
  console.log('    ② 把 Replanner 换成确定性校验（类型检查、lint、单测通过才算一步完成），')
  console.log('       就从"模型自治"滑向了**代码生成 Agent** 的领域 —— 计划即代码，执行即运行测试。')
  console.log()
  console.log('  想跟第 8 课接上：LangGraph 官方有 plan-execute 的图实现，')
  console.log('  节点就是本课这三个角色。你现在能一眼读出它的节点和边了 ——')
  console.log('  这就是手写一遍的价值。')
}

// ---------- 入口：用 argv 分档 ----------

if (!API_KEY) throw new Error('缺少 DEEPSEEK_API_KEY，请在 .env 里配置')

const which = process.argv[2] ?? '1'

if (!['1', '2', '3'].includes(which)) {
  console.log(`未知档位「${which}」，可选：1（三角色）/ 2（执行器粒度）/ 3（重规划时机）`)
  process.exit(1)
}

console.log('='.repeat(64))
console.log('第 9 课 Plan-and-Execute —— 目标')
console.log('='.repeat(64))
console.log(`  ${GOAL}`)
console.log('  （注意：广州的数据源是**必然失败**的，这是刻意的 —— 逼 Replanner 改道）')

// ★ 顶层兜底：模型输出不可信这件事，一路兜到入口。
//   跑挂了不可怕，可怕的是挂得没有信息。
try {
  if (which === '1') {
    await demo1()
    epilogue()
  } else if (which === '2') {
    await demo2()
  } else {
    await demo3()
  }
} catch (e) {
  console.log(`\n  ! 运行中断：${e instanceof Error ? e.message : String(e)}`)
  console.log('    这类错误多半来自模型输出没通过 zod 校验 —— 重跑一次通常就好（温度带来的随机性）。')
  process.exitCode = 1
}

if (which !== '1') {
  console.log(`\n${'='.repeat(64)}`)
  console.log('  接着看：')
  console.log('    npm run l9       完整三角色（默认，含最后的"多说一句"）')
  console.log('    npm run l9 -- 2  换执行器粒度')
  console.log('    npm run l9 -- 3  换重规划时机')
}
