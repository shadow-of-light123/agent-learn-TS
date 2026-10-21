# Plan-and-Execute：先想清楚，再动手

> 承接：07 课 demo 2（简化版规划者/执行者）、08 课（LangGraph 里有这个模式的官方实现）。
> 这份文档把它作为独立模式补完整——包括你在 demo 2 里没写的那半个角色：**Replanner**。

---

## 1. 一句话本质

**把「想」和「做」拆成两个独立环节：先用一次 LLM 调用生成完整的结构化计划，然后按计划执行，执行中根据实际情况修正计划。**

对比你已经很熟的东西：

| 模式 | 决策方式 | 你写过的 |
|---|---|---|
| ReAct（03 课 Agent Loop） | 走一步看一步，每步都是完整的 LLM 调用 | `npm run l3` |
| 硬编码编排 | 计划是人写死的（Spring AI 模板方法那种） | 你面试平台的后端链路 |
| **Plan-and-Execute** | **计划由 LLM 动态生成，但一次生成、分步执行、可修正** | 07 课 demo 2（缺 Replanner） |

用你熟的类比：ReAct 像运行时逐帧决策，Plan-and-Execute 像**先构建出完整的任务 DAG 再跑构建**——计划本身成了可审查、可缓存、可并行调度的产物。

---

## 2. 为什么需要它：ReAct 的两个病

你在 07 课已经亲眼见过第一个病。

**病一：长任务失焦。** ReAct 每步只决定"下一步干嘛"，全局视野 = 当前 messages 数组。任务一长，上下文被工具结果灌满（04 课的问题），模型开始忘原始目标、在细节里打转。

**病二：成本结构差。** ReAct 的每次"想"都带着全部历史——第 N 轮的输入 ≈ 前 N-1 轮所有内容之和，**平方级**增长（07 课 epilogue 那笔账）。而"想下一步"其实不需要那么贵的脑子。

Plan-and-Execute 的药方：

- Planner **一次**调用拿到全局方案 → 用大模型也只花一次的钱
- Executor 每步只需要执行具体指令 → **可以换小模型**，甚至纯代码
- 计划是结构化数据 → 人能先审查再放行、能存库、能并行无依赖的步骤

**反直觉但重要：Plan-and-Execute 通常不省总 token，省的是「贵模型的调用次数」和「决策质量」。** ReAct 十轮 = 十次大模型满上下文调用；Plan-and-Execute = 1 次大模型规划 + N 次小模型执行。

---

## 3. 三个角色

```
                ┌─────────────┐
      goal ───▶ │   Planner   │  一次调用，输出结构化 Plan
                └──────┬──────┘
                       ▼
                 plan.steps[]
                       │
          ┌────────────▼────────────┐
          │       Executor          │  逐步执行（每步一个小调用
          │  执行 step[0] → 记录结果 │  或一个子 Agent）
          └────────────┬────────────┘
                       ▼
                ┌─────────────┐
                │  Replanner  │  goal + past_steps + 剩余计划
                └──────┬──────┘           │
            ┌──────────┴──────────┐       │
            ▼                     ▼       ▼
      "计划继续/修改"        "任务完成"  返回 response
            │                     │
            └──▶ 回 Executor       └──▶ 结束
```

### Planner

- **输入**：goal（+ 可能的背景信息）
- **输出**：结构化 Plan（zod 卡住，07 课第三次用 safeParse 的那招，这里第四次）
- **铁律**：步骤参数必须是**顶层结构化字段**，不能塞在自然语言里让执行器去正则抠（你在 demo 2 用 "12" 坑过分析师，还记得）

### Executor

两种粒度，按需选：

1. **直接执行**（07 课 demo 2 的做法）：计划里写明 `tool + args`，执行器就是 `executeTool(step)` 纯代码，**零 LLM 调用**。适合工具集稳定、步骤可完全静态确定的场景。
2. **每步一个子 Agent**（LangGraph 官方示例的做法）：把 step 的 action 丢给一个带工具的 ReAct Agent 自己跑。适合步骤本身还需要临场判断的场景。

粒度 2 = Plan-and-Execute 和 07 课「子 Agent / 上下文隔离」的组合：外层管全局，内层各自消化过程。**这就是为什么这两个模式总是一起出现。**

### Replanner

这是 demo 2 缺的那半个角色。demo 2 里只有"失败才重规划"，且重规划是完整重来。真正的 Replanner：

- **输入**：goal + `past_steps`（已完成步骤及结果）+ 剩余计划
- **输出二选一**：新的 Plan（修正后继续）/ 最终 Response（任务完成）
- **它能看到执行中学到的新事实**——比如"广州数据源挂了"，它可以把后续步骤改成"用上海+北京推算"或"结论里注明缺口"，而不是只会失败重试

---

## 4. 最小完整实现（骨架）

基于你 07 课的代码风格，可以直接贴进新文件跑。省略了 `callModel` / `executeTool` / 工具注册表——跟 07 课完全一样，直接复制。

```typescript
import { z } from 'zod'

// ---------- ① 两个核心 Schema ----------

// Plan：Planner 和 Replanner 共用同一个结构
const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        action: z.string().describe('这一步做什么，写给执行器看'),
        tool: z.enum(['get_sales', 'calculate', 'none']),
        city: z.string().nullable(),
        expression: z.string().nullable(),
      }),
    )
    .min(1),
})
type Plan = z.infer<typeof PlanSchema>

// ★ Replanner 的输出是个**联合类型**：要么给新计划，要么宣布完成。
//   这是和 demo 2 最大的区别 —— demo 2 的重规划永远产出新计划，
//   完成与否由外部代码判断；这里"何时收工"本身成为模型的决策。
const ReplanOutput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('continue'),
    plan: PlanSchema.describe('修正后的完整计划（含剩余步骤）'),
  }),
  z.object({
    type: z.literal('finish'),
    response: z.string().describe('最终回答'),
  }),
])
type ReplanResult = z.infer<typeof ReplanOutput>

// ---------- ② Planner ----------

async function makePlan(goal: string, meter: Meter): Promise<Plan> {
  const raw = await callModel(
    [
      { role: 'system', content:
        '你是任务规划者。把目标拆成尽量少的步骤，每步指定工具和参数。\n' +
        '只输出 JSON：{"steps":[{"action":"...","tool":"...","city":...,"expression":...}]}' },
      { role: 'user', content: `目标：${goal}` },
    ],
    [], meter,
  )
  // 老三样：剥 markdown 围栏 → JSON.parse → safeParse
  const parsed = PlanSchema.safeParse(JSON.parse(raw.content!.replace(/^```(?:json)?|```$/gm, '').trim()))
  if (!parsed.success) throw new Error(`计划结构不对：${parsed.error.message}`)
  return parsed.data
}

// ---------- ③ Executor：两种粒度 ----------

// 粒度 1：纯代码直接执行（demo 2 的做法，零 LLM 调用）
function executeStepDirect(step: Plan['steps'][number]): string {
  if (step.tool === 'none') return '（无需工具）'
  const args = step.tool === 'get_sales' ? { city: step.city } : { expression: step.expression }
  return executeTool({ id: 'plan-step', function: { name: step.tool, arguments: JSON.stringify(args) } })
}

// 粒度 2：每步丢给一个 ReAct 子 Agent（07 课的 runAgent 原样复用）
async function executeStepAsAgent(step: Plan['steps'][number], meter: Meter): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: '你是执行者。完成给定的单步任务，只回传结果，不要发挥。' },
    { role: 'user', content: step.action },
  ]
  const done = await runAgent(messages, meter, /* verbose */ false)
  return finalText(done) // ★ 过程留在这条 messages 里，只回传结论 —— 07 课的上下文隔离
}

// ---------- ④ Replanner ----------

async function replan(
  goal: string,
  pastSteps: { action: string; result: string }[],
  remaining: Plan['steps'],
  meter: Meter,
): Promise<ReplanResult> {
  const raw = await callModel(
    [
      { role: 'system', content:
        '你是重规划者。根据已完成步骤的结果，决定：修正剩余计划（continue），' +
        '或宣布任务完成并给出最终回答（finish）。\n' +
        '输出 JSON：{"type":"continue","plan":{"steps":[...]}} 或 {"type":"finish","response":"..."}\n' +
        '★ 某步失败时优先考虑改道（换数据源、调整结论口径），不是原样重排。' },
      { role: 'user', content:
        `目标：${goal}\n\n已完成：\n${pastSteps.map((s, i) => `${i + 1}. ${s.action} → ${s.result}`).join('\n')}` +
        `\n\n剩余计划：\n${remaining.map((s) => `- ${s.action}`).join('\n')}` },
    ],
    [], meter,
  )
  const parsed = ReplanOutput.safeParse(JSON.parse(raw.content!.replace(/^```(?:json)?|```$/gm, '').trim()))
  if (!parsed.success) throw new Error(`重规划输出不合法：${parsed.error.message}`)
  return parsed.data
}

// ---------- ⑤ 主循环：Plan → Execute → Replan ----------

const MAX_REPLAN = 4 // 保险丝：防止 replanner 无限改计划

async function planAndExecute(goal: string): Promise<string> {
  const meter = newMeter('Plan-and-Execute')
  let plan = await makePlan(goal, meter)
  const pastSteps: { action: string; result: string }[] = []

  for (let round = 0; round <= MAX_REPLAN; round++) {
    // 执行到计划尽头（也可以只执行一步就 replan —— 见下文「重规划时机」）
    for (const step of plan.steps) {
      const result = await executeStepAsAgent(step, meter) // 或 executeStepDirect
      pastSteps.push({ action: step.action, result })
      console.log(`  ✓ ${step.action}`)
    }

    // 拿着全部执行记录去重规划
    const decision = await replan(goal, pastSteps, [], meter)
    if (decision.type === 'finish') {
      console.log(`\n  ${report(meter)}`)
      return decision.response
    }
    plan = decision.plan // 换上新计划，进入下一轮
    if (round === MAX_REPLAN) return '重规划次数用尽，强制收尾。'
  }
  return ''
}
```

跑法照旧：复制 07 课的常量、`callModel`、工具注册表，加一个入口：

```typescript
const answer = await planAndExecute('对比北京、上海、广州过去一年的销售表现，指出最需要关注的城市。')
console.log(answer)
```

---

## 5. 三个关键设计决策

这三个旋钮决定了你的实现是玩具还是能用，比代码本身重要。

### 决策一：重规划的时机

| 档位 | 做法 | 代价 / 适用 |
|---|---|---|
| 每步之后 | 执行 1 步 → replan 1 次 | 最灵活，**但 replan 次数 = 步骤数，最贵**。LangGraph 官方示例是这档 |
| 每轮计划跑完 | 整份计划执行完 → replan | 便宜，但对"第 2 步就注定失败"的计划会白白跑完后面所有步 |
| **失败才重规划** | demo 2 的做法 | 最省，但学不到"执行中的新机会"（比如发现某数据其实免费可得） |

★ 折中的工程做法是**检查点**：给步骤打 `dependsOn` 标记，无依赖的步骤先跑，有依赖的步骤在依赖完成后先 replan 再跑。这就自然过渡到 DAG（见第 7 节）。

### 决策二：执行器粒度

- 工具集小且稳定 → **粒度 1**（纯代码），快、零成本、完全可测
- 步骤需要临场判断（"分析这个城市的销售趋势"需要自己决定调几次工具）→ **粒度 2**（子 Agent）
- ★ 别全上粒度 2。你在 07 课实测过：子 Agent 让调用次数翻倍。每步都开子 Agent 的 Plan-and-Execute，调用数 = 计划轮数 × 每轮步数 × 每步内部轮数，账要这么算。

### 决策三：past_steps 怎么传

- 短任务：全量塞给 Replanner，没问题
- 长任务：past_steps 自己也会膨胀——**04 课的摘要压缩在这里原样适用**。每步结果先过一遍"压成一句话"，或者 Replanner 输入里只带最近 K 步 + 更早步骤的单行摘要
- ★ 常见坑：把工具的原始 JSON 全文塞进 past_steps。执行器看到的 900 字明细，Replanner 不需要再看一遍——传结论，不传原文（07 课"只回传结论"原则，作用范围扩大到编排层）

---

## 6. 什么时候用 / 不用

**用：**

- 任务天然分阶段，且阶段划分在开始时就大体可知（调研 → 计算 → 汇总）
- 需要人审查计划再放行（计划是数据，可以插入审批 UI——这是 ReAct 做不到的，ReAct 的"计划"散在每轮决策里，不可截获）
- 想用大小模型分工省钱（Planner 用 deepseek-v4-pro 级别，Executor 用 deepseek-flash 级别）
- 步骤间可并行（无依赖步骤 `Promise.all`，07 课 demo 3 的并行收益直接继承）

**不用：**

- 2~3 步的小任务：ReAct 一轮顶过去，先规划反而多花一次调用 + 更高延迟
- 计划完全取决于执行反馈的任务（探索式调试、对话式交互）：每步都推翻计划，replan 开销全白花
- ★ 老实说：**90% 的任务，03 课那个 while 循环 + 一组好工具就够了**。Plan-and-Execute 买到的是"全局视野 + 可审查 + 大小模型分工"，为这些付三倍工程复杂度之前，先确认你真的需要它们。

---

## 7. 进阶：从链到 DAG

经典 Plan-and-Execute 的计划是**线性列表**，但计划里的步骤经常互相独立。两个进化方向：

1. **LLMCompiler**（Kim et al. 2024）：Planner 直接输出 DAG（步骤 + 依赖边），无依赖步骤真并行执行，把 LLM 编排干到接近数据流图的效率。LangGraph 有对应实现（`@langchain/langgraph` 1.x 的 prebuilt 里可以找到思路复刻）。
2. **Plan-and-Solve Prompting**（Wang et al. 2023）：单 prompt 版——不做任何工程，只让模型"先制定计划再按计划执行"地一次输出。Plan-and-Execute 的思想源头之一，适合验证某个任务类型是否吃"先规划"这一套，再决定要不要上完整架构。

再往后的自然延伸：把 Replanner 换成确定性校验（类型检查、lint、单测通过才算 step 完成），就从"模型自治"滑向了**代码生成 Agent** 的领域——计划即代码，执行即运行测试。

---

## 8. 延伸阅读

- LangChain 博客 *Plan-and-Execute Agents*（2024-02）—— 本模式名字的出处，里面的 demo 就是"每步一个子 Agent + 每步 replan"
- LangGraph 官方示例 `plan-execute` —— 第 4 节骨架的 Graph 化版本，你在 08 课的基础上可以直接读懂它的节点和边
- BabyAGI（2023）—— 更早的"任务列表循环"鼻祖，没有 Replanner，靠任务优先级排序
- ReAct 论文（Yao et al. 2022）—— 对比基准，03 课的循环就是它

---

## 9. 一页总结

```
Plan-and-Execute = Planner(一次大调用) + Executor(每步小调用/子Agent) + Replanner(每轮/每步修正)

三个旋钮：
  重规划时机   每步 / 每轮 / 失败才（默认从"每轮"开始，别一上来就"每步"）
  执行器粒度   纯代码 / 子Agent（默认纯代码，临场判断多的步骤才升级）
  past_steps   全量 / 摘要（长了就摘要，04 课原样适用）

判断要不要用：
  任务分阶段且开局可知 → 用
  计划需要人审批 → 用（计划是数据，天然可插审批）
  两三步的小事 → ReAct
  计划全靠执行反馈 → ReAct
```
