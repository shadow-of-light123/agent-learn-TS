# agent-learn

从零手写 Agent —— 不用任何框架，用 TypeScript + Node 直接调 LLM API，逐层理解 Agent 的本质。

> Agent 的全部秘密其实就一句话：**LLM 在一个循环里，根据对话历史决定下一步做什么，直到任务完成。**
> 框架（LangChain、Vercel AI SDK、Coze……）只是把这个循环和周边设施封装得更方便。

## 学习路线

| 课程 | 主题 | 核心概念 | 状态 |
|---|---|---|---|
| 01 | Hello LLM | 裸调 Chat API、消息角色、流式输出（SSE） | ✅ |
| 02 | Tool Calling | 函数调用协议、模型如何「调用」你的代码 | ✅ |
| 03 | Agent Loop | while 循环 + 工具 + 自主决策，第一个真 Agent | ✅ |
| 04 | Memory | 会话历史管理、上下文窗口、摘要压缩 | ✅ |
| 05 | RAG | Embedding、向量检索、给 Agent 外挂知识库 | ✅ |
| 06 | MCP | Model Context Protocol，工具的标准化协议 | ✅ |
| 07 | Multi-Agent | 规划者/执行者、子 Agent、上下文隔离 | ✅ |
| 08 | Framework | 用 LangChain.js 复刻前面所学（手写 vs 框架对照） | ✅ |
| 09 | Plan-and-Execute | Planner / Executor / Replanner 三角色，三个旋钮的实测对账 | ✅ |

## 运行方式

```bash
npm install
# 配置 API Key（DeepSeek + 硅基流动，见 .env.example）
cp .env.example .env   # 然后填入你的 key
```

每课都有独立入口，直接跑即可：

```bash
# 01 ~ 09 主线
npm run l1     # Hello LLM（+ npm run l1:stream 看流式）
npm run l2     # Tool Calling
npm run l3     # Agent Loop
npm run l4     # Memory（+ npm run l4:test 用管道输入复现压缩）
npm run l5     # RAG：朴素 RAG 与 Agentic RAG 两种接法（+ npm run l5:test）
npm run l6:agent  # MCP：接上外部工具跑 Agent Loop
npm run l7     # Multi-Agent（默认跑子 Agent 那档）
npm run l8     # Framework：用 LangChain 复刻（+ npm run l8:stream）
npm run l9     # Plan-and-Execute（默认跑完整三角色）

# 单独看某一层
npm run l5:explore   # 只看检索层，不调 LLM —— 先确认检索准不准
npm run l6:raw       # 手写 JSON-RPC 的 MCP，原始报文肉眼可见
npm run l6:sdk       # 同一个 server 用官方 SDK 重写，做对照
```

第 05 课需要额外的 embedding 服务（DeepSeek 没有 embedding 接口），
用硅基流动的 `BAAI/bge-m3`，在 `.env` 里填 `SILICONFLOW_API_KEY`。

第 07 课按档跑：

```bash
npm run l7 -- 1      # 单 Agent 硬扛
npm run l7 -- 1 8    # 同上，但城市数提到 8（看上下文怎么被撑爆）
npm run l7 -- 2      # 规划者 / 执行者
npm run l7           # 子 Agent（默认，本课落点）
```

> 第 07 课的三个 demo 都是多轮 LLM 调用，**别一次全跑** —— 又慢又烧钱。

第 09 课也是多轮调用，同样按档跑：

```bash
npm run l9        # 完整三角色：Planner → Executor(纯代码) → Replanner
npm run l9 -- 2   # 换执行器粒度：每步一个子 Agent（跑完会跟粒度 1 对账）
npm run l9 -- 3   # 换重规划时机：每步都 replan（跑完会跟每轮 replan 对账）
```

> 第 09 课跟第 07 课 demo 2 是**同一道题**（对比北京/上海/广州，广州数据源必然失败），
> 可以直接对照着看：07 课有 Planner + Executor 但缺 Replanner，
> 09 课补上的正是"何时收工由模型自己决定"这半个角色。

## 你已有的基础如何对应

- 你在 AI 面试平台写过的 SSE 流式渲染 → 第 1 课直接复用
- Axios 请求调度引擎 → 第 2 课的工具调用本质是「模型反向来调度你的函数」
- Spring AI 的 Agent 工作流对话 → 到第 3 课你会明白那套「模板方法编排」里每个环节为什么存在

## 文档沉淀

`docs/` 放主课程之外的专题笔记——由讨论沉淀而成，比课程注释更长、更成体系：

| 文档 | 主题 |
|---|---|
| [上下文压缩：token 预算怎么分配](docs/context-compaction-budget.md) | 补第 04 课没展开的部分：预算怎么切分、迟滞区间、前缀缓存的隐藏成本 |
