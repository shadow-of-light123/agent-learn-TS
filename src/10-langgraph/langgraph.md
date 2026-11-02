# LangGraph：把 Agent 循环画成图

> 承接：03 课（你手写 while 循环）、08 课（`createAgent` 把循环藏进框架，结尾留了一笔"想加人工审批得去读 middleware 文档"的债）。
> 这份文档是 10 课代码的配套讲义：先讲清"图到底解决了什么"，再把四个 demo 的图拆开看，最后是版本坑和选型判断。

---

## 1. 一句话本质

**图不是更高级的 Agent 框架，而是把你本来写在 while 里的控制流，变成一份可以被框架读懂、保存、暂停、恢复的数据结构。**

三个词对应三件事：

| 你原来的写法 | 图里的对应物 | 多出来的能力 |
|---|---|---|
| `while (true) { ... }` 循环体 | 节点 + **回指边** | 每一步之后框架能插手：存快照、停下等外部输入 |
| `if (!msg.tool_calls) break` | **条件边**（路由函数） | 走哪条路由由 state 决定，可以被审查/记录 |
| `messages` 数组 | **state + reducer** | state 是共享黑板，每个节点只交增量 |

换句话说：**LangGraph 把"控制流"从代码里搬到了数据里。** 代码里搬出去的东西，运行时才能被保存、被替换、被人工改写——这是它相对 while 循环的全部卖点。

---

## 2. 为什么需要它：08 课那笔债

08 课用 `createAgent` 一行跑通了 Agent，然后你自己在尾声列了三条代价：

- **循环不可改**：想加"第 3 轮必须人工确认"，只能去翻 middleware 文档，还未必有现成的
- **状态不可见**：出问题只能"看"，不能拿、不能存、不能倒带
- **API 变得快**：`createReactAgent` 住 `@langchain/langgraph/prebuilt`，新版又建议改用 `createAgent`——框架 API 比你的业务跑得快

这三条不是 `createAgent` 的 bug，而是**抽象层级的必然**：它替你做的决定越多，你想改的时候能插手的缝隙就越少。

10 课做的事，就是把这笔债一笔笔还上：

| 08 课的问题 | 10 课的能力 | 代码位置 |
|---|---|---|
| 循环长什么样看不见 | 循环 = 你 `addNode` 的名字 + `addEdge` 的回指边 | Demo 2 |
| 人工审批要读 middleware 文档 | 工具节点里一个 `interrupt()` + `Command({ resume })` | Demo 3 |
| 失败只能看日志 | `getState` / `getStateHistory` 拿到每个 superstep 的完整快照 | Demo 3 |
| 计划和执行糊在一起 | planner / executor / replanner 各是一个节点，计划是 state 里的数据 | Demo 4 |

**关键认知：不是"用了 LangGraph 就自动具备这些能力"，而是"你亲手把循环画出来，框架才有地方插这些能力"。**

---

## 3. 一张图的最小词汇表

先记住这五个词，其余都是细节。

### State：共享黑板

```ts
const State = Annotation.Root({
  question: Annotation<string>(),   // 默认 LastValue：谁最后写算谁的
  messages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: (left, right) => left.concat(right),  // 追加，不是覆盖
    default: () => [],
  }),
})
```

★ **节点返回的是增量，不是新 state。** 节点里 `return { answer: '...' }`，就只改 `answer` 一个字段，其余字段保留。第一次写的人常把整个 state 原样返回——在 `messages` 这种带 reducer 的字段上，那等于**重复追加一遍历史**。

### Node：一个 async 函数

```ts
.addNode('agent', async (state) => {
  const res = await model.invoke(state.messages)
  return { messages: [res] }   // 交给 reducer 合并
})
```

节点里可以是任何东西：LLM 调用、工具执行、纯计算、HTTP 请求。**节点边界 = 你想让框架"停一下"的地方**（存 checkpoint、插入中断、失败重试都以节点为单位）。

### Edge：两种

```ts
.addEdge(START, 'agent')                       // 固定边：跑完这个就跑那个
.addConditionalEdges('agent', routeAfterAgent) // 条件边：看 state 决定下一个是谁
```

路由函数就是第 3 课 while 的出口判断搬到外面：

```ts
function routeAfterAgent(state) {
  const last = state.messages.at(-1)
  return AIMessage.isInstance(last) && last.tool_calls?.length ? 'tools' : END
}
```

### Reducer：合并规则

| 字段语义 | reducer | 例子 |
|---|---|---|
| 最新值覆盖（问题、答案、标志位） | `(_left, right) => right`（LastValue 默认） | `answer`、`blocked` |
| 只增不减（对话历史、已完成步骤） | `left.concat(right)` | `messages`、`past` |
| 自己定义的合并（计数、集合去重） | 任意 `(state, update) => newState` | 本课没用，但这是扩展点 |

### Checkpointer：快照存储

```ts
.compile({ checkpointer: new MemorySaver() })
app.invoke(input, { configurable: { thread_id: 'demo3-approve' } })
```

- `thread_id`：哪段历史属于同一个"会话"。第 4 课你把历史存成数组，这里存成按 thread 索引的 checkpoint 链。
- **没有 checkpointer，就没有中断、恢复、倒带、多轮记忆。** 这些能力全建立在"每一步之后状态被存下来"之上。
- `MemorySaver` 存进程内存，进程退就没了；生产的 Sqlite / Postgres saver 接口一样，只是换存储。本课按约定只用内存版。

---

## 4. 四个 demo 的图

### Demo 1：最小图（固定流水线）

```
START → fetch_weather → compose → END
```

- 节点可以完全不调模型（`fetch_weather` 是纯函数）
- `invoke` 返回**跑完之后整个 state**，不是最后一条消息
- `getGraphAsync()` 能反过来读出图的结构（节点、边），调试图/写文档时省事

★ 实测坑：**节点名不能和 state 字段重名。** 最初这个节点叫 `answer`，撞了 `state.answer`，LangGraph 编译期直接抛：

```
answer is already being used as a state attribute (a.k.a. a channel),
cannot also be used as a node name.
```

命名空间是共用的，所以本课把它改成了 `compose`。

这张图的重点是让你确认：图的一套零件（state / node / edge / compile）本身不复杂。它不解决任何新问题——**图的威力在"下一步走哪取决于 state"时才出现**。

### Demo 2：ReAct 循环图（本课重点）

```
                ┌──────────────┐
   START ─────▶ │    agent     │ ──(没有 tool_calls)──▶ END
                └──────┬───────┘
                       │ (有 tool_calls)
                       ▼
                ┌──────────────┐
                │    tools     │
                └──────┬───────┘
                       │ 回指边（这就是"循环"）
                       └──────────▶ agent
```

跟第 3 课 while 的逐行对应：

| 第 3 课 while | Demo 2 图 |
|---|---|
| `while (true) {` | `tools → agent` 回指边 |
| `const res = await callModel(messages)` | `agent` 节点 |
| `if (!res.tool_calls) break` | `agent` 的条件边路由到 `END` |
| `for (const call of tool_calls) executeTool(call)` | `tools` 节点 |
| `messages.push(...)` | `messages` 字段的 reducer |

本课故意**不用**框架的 `MessagesAnnotation` / `ToolNode`，就是为了让你自己写一遍 reducer——框架内部干的也就是这件事。

两个新东西：

1. **`streamMode: 'updates'`**：每个 chunk 是 `{ 节点名: 这一步的增量 }`。节点名是你起的，所以你能一眼看出"第几轮、谁在动"。第 8 课你只能看到框架内部节点名，这就是区别。
2. **`recursionLimit`**：图的保险丝，默认 25。★ 它按 **superstep** 计数，不是"模型轮数"——一圈 `agent + tools` 花 2 个 superstep，别跟第 3 课的 `MAX_ITERATIONS` 混为一谈。

### Demo 3：人在环里

```
START → agent ─(要工具)→ tools ─┬─(approve)→ 执行工具 → 回 agent → ... → END
                                  └─(reject)─→ blocked=true → END
```

中断点放在**工具执行之前**：模型已经点了菜，但还没下单。

```ts
const decision = interrupt<Payload, 'approve' | 'reject'>({ question, calls })
```

第一次 `invoke` 会跑到这里停住，返回 `{ __interrupt__: [...] }`（用 `isInterrupted()` 收窄）；checkpoint 里 `next` 显示 `['tools']`——恢复后第一个要跑的就是它。

恢复时**换一种输入**：

```ts
app.invoke(new Command({ resume: 'approve' }), config)
```

同一个 `invoke`，两种入口：普通输入 = 开跑；`Command({ resume })` = 从断点续跑。

★★ **本课最大的坑：interrupt 会让节点从头重跑。** 恢复不是从中断那一行继续，而是重新执行整个节点，让 `interrupt()` 这次返回 resume 值。所以 `interrupt()` 之前的代码会执行两遍——写库写两条、扣钱扣两次。规矩：

- `interrupt()` 之前：只读 state、算 payload，**无副作用**
- 有副作用的事：全部放到 `interrupt()` 之后

还有一个实测行为值得记住：**一次批准不一定够。** 模型第一轮查完天气，第二轮又要点 `calculate`，图会**再次中断**。真实系统里"批准几次"的循环必须自己写——图只负责停住，"谁来判断"是你的事。本课 Demo 3 的 `while (isInterrupted(...))` 就是这层循环。

最后 `getStateHistory(config)` 倒带：每个快照都是"某个 superstep 之前存下的完整 state"，**新的在前**。

### Demo 4：Plan-and-Execute 图化（复刻第 9 课）

```
START → planner → executor → replanner ─(finished)→ END
                      ▲          │
                      └─(continue)┘
```

第 9 课那三个角色，在 09 里是 for 循环里的三坨代码；在这里是三个节点：

| 09 课 | 10 课 | 变化 |
|---|---|---|
| `makePlan()` | `planner` 节点 | 一样，只是输出进 state.plan |
| `executeStepDirect()` 的 for 循环 | `executor` 节点 | 一样，纯代码，零 LLM 调用 |
| `replan()` + `if (finished) return` | `replanner` 节点 + 条件边 | **`if` 变成了条件边** |
| `for (let round = 0; round < MAX_REPLAN; round++)` | 条件边 + state.replans | 熔断逻辑进节点，路由靠 state |

★ 图没有改变算法，只改变了编排的写法。所以**对账要按调用次数/步骤数对，不能按 token 对**：09 用 `JSON.stringify().length/2` 粗估输入，10 课读供应商返回的 `usage_metadata` 真实 token，口径不同。

图真正买到的是三样：**计划是数据**（能审查、能存库）、**每一步可中断**（Demo 3 的能力，这里没接）、**角色边界清晰到能单测**。

---

## 5. 三个关键设计决策

### 决策一：要不要上 LangGraph

| 你的情况 | 选择 |
|---|---|
| 2~5 步、单 Agent、不需要人工审批 | **第 3 课的 while**，别引入图 |
| 想快速搭个 Agent 跑通，循环不需要改 | `createAgent`（08 课），别自己画 |
| 需要"停下等人"（审批/补充信息/多轮确认） | **StateGraph**，这是图最硬的场景 |
| 需要跨进程续跑、失败重放、按 thread 隔离历史 | **StateGraph + checkpointer** |
| 多角色（规划/执行/评审）且边界要能单独测 | **StateGraph**，节点边界天然是测试边界 |

一句话：**图买的是"可恢复 + 可审查 + 可编排"，付的是"多一层抽象"。** 90% 的任务，while + 一组好工具就够了——这句话第 9 课说过一次，这里再说一次。

### 决策二：状态放什么

- 对话历史 → `messages`，reducer 追加
- 结构化中间产物（计划、步骤记录）→ 独立字段，LastValue 或追加
- **不要把所有东西塞进一条 messages 字符串**：图的好处就是 state 可以结构化，塞回自然语言等于自废武功
- 累计字段（`past`）会膨胀——第 4 课摘要压缩在这里原样适用

### 决策三：中断点放哪

| 位置 | 做法 | 适合 |
|---|---|---|
| 工具执行前 | 工具节点里 `interrupt()` | 审批"模型要调什么工具"（本课） |
| 节点执行前 | `compile({ interruptBefore: ['tools'] })` | 静态审批点，不需要 payload |
| 节点执行后 | `compile({ interruptAfter: ['planner'] })` | 审批"计划/中间产物" |

★ 动态 payload（要审批的具体参数）用 `interrupt()`；固定的流程卡点用 `interruptBefore/After`。两者都要 checkpointer。

---

## 6. 版本坑清单（@langchain/langgraph 1.4.15 实测）

这一节是给未来的你省时间的——网上教程大半是 0.x 的写法。

1. **`MemorySaver` 从根路径导**：`import { MemorySaver } from '@langchain/langgraph'`。1.4.15 的 `exports` 里**没有** `./checkpoint`、也没有 `./func`，老教程里的 `@langchain/langgraph/checkpoint/memory` 会直接解析失败。
2. **`new StateGraph({ channels: ... })` 旧构造器已 deprecated**，用 `Annotation.Root(...)` 或 zod schema。
3. **`createReactAgent` 住 `@langchain/langgraph/prebuilt`，已标 `@deprecated`**，官方建议改用 `langchain` 的 `createAgent`（08 课已踩过一次）。
4. **`getGraph()` deprecated → `getGraphAsync()`**。
5. **节点名不能和 state 字段重名**（见 Demo 1 实测报错）。
6. **`interrupt()` 会让节点从头重跑**（见 Demo 3）——这是坑，不是 bug；设计中断点时必须考虑幂等。
7. **`recursionLimit` 按 superstep 计**，默认 25；它防"图卡死"，不防"钱烧光"，业务熔断要自己写。
8. **`withStructuredOutput` 在 deepseek-flash 的思考模式上不可用**（本课实测三种 method 全 400）：
   - 默认（json_schema）：`This response_format type is unavailable now`
   - `{ method: 'functionCalling' }`：`Thinking mode does not support this tool_choice`
   - `{ method: 'jsonMode' }`：prompt 必须出现 "json" 字样，且联合类型 schema 的输出约束不住
   
   所以 Demo 4 老老实实回到第 9 课的 `jsonCall`：剥围栏 → `JSON.parse` → `safeParse` → 失败把 `issues` 回传模型改一次。**框架帮不到你的地方，你手写过的版本就是资产。**
9. **没有 checkpointer 时**，`getState` / `getStateHistory` 会抛 `GraphValueError`；`interrupt` 也没有续跑的基础。看到这个错，先查 `compile` 有没有传 checkpointer。

---

## 7. 函数式 API（10 行带过）

除了 `StateGraph` 构建器，LangGraph 还有一个函数式 API：用 `entrypoint` + `task` 把一段代码包成带 checkpoint 的 DAG。

```ts
import { entrypoint, task } from '@langchain/langgraph'

const add = task('add', async (a: number, b: number) => a + b)
const main = entrypoint('main', async (x: number) => (await add(x, 1)) * 2)

await main.invoke(41)   // 84
```

- 适合：一次调用内部的几个步骤、需要重试/缓存/并行，但**不需要显式画图**
- 不适合：需要人工中断、需要多角色编排、需要给别人看"流程长什么样"
- 本课只推 `StateGraph`：图的形状是能拿出去讲、拿出去审的东西，这正是本课要的

---

## 8. 延伸阅读

- LangGraph JS 官方文档 —— 概念（State / Node / Edge / Persistence）与 API 参考的权威来源：<https://langchain-ai.github.io/langgraphjs/>
- LangGraph 官方 *Human-in-the-loop* 指南 —— `interrupt` / `Command` / 审批模式的更多写法
- LangGraph 官方 *Plan-and-Execute* 教程 —— 第 9 课讲义里提过的那份实现，10 课 Demo 4 是它的最小复刻
- 03 课的 Agent Loop、04 课的 token 预算与摘要压缩、07 课的上下文隔离 —— 这三课是理解"为什么图要这么设计"的前置
- LangChain 博客 *Plan-and-Execute Agents*（2024-02）—— Plan-and-Execute 模式的命名出处

---

## 9. 一页总结

```
LangGraph = 把控制流从代码搬到数据
  state     共享黑板，节点只交增量（reducer 决定怎么合并）
  node      一个 async 函数 = 一个"可以停一下"的边界
  edge      固定边 = 顺序；条件边 = 第 3 课的 break/continue 搬到外面
  compile   checkpointer 在这一步注入；没有它就没有中断/恢复/倒带
  interrupt 节点里一个函数调用，停下等人；★ 恢复时节点从头重跑

四个 demo 记什么：
  1  最小图：确认零件不复杂；节点名不能撞 state 字段
  2  循环图：回指边 + 条件边 = while；streamMode 'updates' 能看见每一步
  3  中断：interrupt + Command(resume)；一次批准可能不够；getStateHistory 倒带
  4  图化 plan-execute：算法没变，if 变条件边；对账按调用次数，不按 token

选型：
  小任务 / 单 Agent / 不需要人审 → 第 3 课的 while，别上图
  要快速跑通、循环不改      → createAgent（08 课）
  要停下等人 / 跨进程续跑 / 多角色可测 → StateGraph + checkpointer

一句话：图不是让 Agent 更聪明，是让"Agent 怎么跑"变成你能看见、能改、能存的东西。
```
