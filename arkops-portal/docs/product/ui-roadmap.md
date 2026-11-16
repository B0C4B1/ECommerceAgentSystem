# ArkOps 界面与交互路线图（UI Loop）

> 编号规则：功能/治理用 `roadmap.md` 的 P 编号；界面与交互用本文的 U 编号。
> 功能依赖先登记到 `roadmap.md` 并完成最小功能闭环，再回到 U 项做界面部分。
> 创建日期：2026-11-14 | 由 UI 自治推演循环维护

## 体验命题

界面替人做判断，而不是等人来解读。每个界面都要在 3 秒内回答三件事：现在什么情况、我该做什么、系统替我做了什么。

三层，每轮只能强化其中一层，并在记录里写明是哪一层：

| 层 | 含义 | 判定标准 |
|:--:|---|---|
| 1 可读 | 信息层级与结论前置 | 不解释也能说出三问答案；口径、时间、归属写在数字旁边 |
| 2 可行 | 操作路径与反馈闭环 | 键盘可达；每个动作有回执；危险动作可撤回；空/加/错三态齐全 |
| 3 可信 | 与设计系统一致 | 颜色只来自 tokens；亮/暗双主题同验；间距字号不漂移 |

硬约束：不新增依赖，不新增后端，不改业务语义，不造只展示不落数据的假入口。

## U1 可读性：核心页首屏三问

- [x] **U1.1** 走查 dashboard / inbox / agents 三页首屏，形成三问缺口清单（页面、代码位置、缺口描述）
- [x] **U1.2** 挑缺口最大的一页重排信息层级：结论前置、次要信息降级、主动作入口唯一
- [x] **U1.3** inbox 首屏补第三问：让「系统自动处理了多少」在首屏可见（证据 I1：`InboxPage.tsx#L2042-L2045` 的「自动处理」tab 无计数徽标，而「待处理」有；验收：首屏不切 tab 即可说出自动处理条数，且与「待处理」计数同源；强化可读）

验收：不解释也能说出三问答案；亮/暗双主题；1440 与 1024 两档宽度。

状态：✅ 已完成（U1.1 走查清单、U1.2 /agents 重排、U1.3 自动处理计数均已落地）。U1.1 清单中的 I2（全账号范围「共 N 条、其中账号级 M 条」口径句）未立项，留作后续可读性候选。

### U1.1 走查缺口清单（2026-11-14，以 merchant@allmall.cn 即 Owner 视角为准）

**dashboard 首屏**

| # | 缺口 | 证据 |
|:--:|---|---|
| D1 | 同屏两个「需要我」的数字，口径没写在一起：角色卡的「归我的升级」和运营台的「待你处理」，人要自己判断两者关系与先后 | `src/pages/dashboard/DashboardPage.tsx#L371`（RoleFocusCard）、`#L410-L413`（`agentConsole.needsYou` + `inboxTotal`） |
| D2 | 「系统替我做了什么」与「关注清单」并列两栏，谁是结论谁是明细没有层级标记，3 秒内要猜 | `src/pages/dashboard/DashboardPage.tsx#L498-L511` |
| D3 | 关注清单默认折叠 3 条，「更多 N 条」没写排序口径（优先级/时间） | `src/pages/dashboard/DashboardPage.tsx#L501-L510` |
| D4 | 首屏图标仍用裸 hex（可信层欠账，归 U4.1） | `DashboardPage.tsx#L379`、`#L497`；`components/dashboard/RoleFocusCard.tsx#L101-L103` |

**inbox 首屏**

| # | 缺口 | 证据 |
|:--:|---|---|
| I1 | 「系统替我做了什么」藏在第三个 tab，且该 tab 没有计数徽标，「待处理」却有 → 首屏说不出自动处理了多少 | `src/pages/inbox/InboxPage.tsx#L2042-L2045` vs `#L1622` |
| I2 | 全账号范围下没有「共 N 条、其中账号级 M 条」的口径句（该句只在单店范围条的另一种写法里） | `src/pages/inbox/InboxPage.tsx#L1626-L1657` |

**agents 首屏（本轮已修）**

| # | 缺口 | 证据 |
|:--:|---|---|
| A1 | 页头唯一动作是向后的「返回自动化配置」，真正的前进动作（批量开通）埋在搜索行里 | 改前 `src/pages/agents/AgentListPage.tsx#L339-L343` + `#L413-L417` |
| A2 | 四张指标卡是目录统计而非结论；「可开通 11」把 7 个可开通与 4 个需升级套餐混算，口径没写在数字旁 | 改前 `AgentListPage.tsx#L370-L376` |
| A3 | 「为什么有的 Agent 还没开」只存在于表格行内红字依赖，首屏不可见 | `AgentListPage.tsx#L132-L135`（`getMissingDeps`） |

三页共同短板排序：agents（三问有两问答不上）> inbox（第三问答不上）> dashboard（三问都有答案，但需二次解读 D1/D2）。


## U2 状态与反馈闭环

- [x] **U2.1** 审计核心页三态（加载/空/错误）覆盖，列缺口与现有 `EmptyState`、`PageSkeleton` 未复用点（2026-11-15：审计清单见下；同轮落地 dashboard 骨架 + 失败重试，其余页缺口留作候选）
- [x] **U2.2** 危险操作确认与可撤回路径（命中的页面写明判断依据）（2026-11-15：命中 /inbox 批量动作——确认框补条数与后果，批量忽略回执内可一键「恢复」；批量完成无 reopen 语义，以处理人+时间留痕满足验收）

验收：任一核心页在无数据、慢加载、接口失败时都有明确下一步；危险动作二次确认且能撤回或留痕。

状态：✅ 已完成（U2.1 三态覆盖、U2.2 危险动作确认与撤回均落地上线）。

### U2.1 三态审计清单（2026-11-15 走查 + 静态核对）

| 页面 | 加载中现状 | 空态 | 错误态 |
|---|---|---|---|
| dashboard | 改前无加载态：`stores` 未返回时 `storeCount=0`，触发「没有店铺 → 去体验演示」横幅（`DashboardPage.tsx#L394`），运营台写「全部清空」（`#L457`），关注清单写「全部清空」 | 有：onboarding 用 `StoreConnectionEmptyState`（`#L334`） | 改前无，失败静默降级为 0/清空；本轮新增骨架（`#L339-L342`）与失败重试（`#L344-L362`） |
| inbox | 无：14 个查询默认 `[]`（`InboxPage.tsx#L381-L407`），首屏把「读取中」渲染成「全部处理完了」+「去配置自动化」（`#L1762-L1769`） | 有：覆盖全空 / 筛选空 / 只看我的三种文案（同处） | 无：任一查询失败都表现为「没有待办」 |
| agents | 无：`agents = []`（`AgentListPage.tsx#L59`），首屏统计与列表先按 0 / 空渲染 | 弱：搜索无结果退回空列表，无专属空态与下一步 | 无 |
| orders | 无：`orders = []`（`OrderAutomationPage.tsx#L149`），摘要先显示 0 单，表格走「暂无订单」（`#L418-L425`） | 有：全空 / 筛选空两种（同处） | 无 |
| settings/members | 无：`data = []`（`MembersSettingsPage.tsx#L21`） | 弱：antd 表格默认「暂无数据」（`#L59`），无下一步 | 无 |

共同缺口：`components/PageSkeleton.tsx` 与 `EmptyState` 此前只服务路由懒加载与空数据，从未被数据加载 / 失败复用；本轮 dashboard 首次把两者用于数据三态。未覆盖页（inbox / agents / orders / settings）按"首屏结论被假 0 / 假空替换"的严重度排队，留作后续候选（不另立编号）。

## U3 可访问性与键盘

- [x] **U3.1** 全局 `focus-visible` 与键盘导航基线（`global.css` 目前无 focus-visible/aria 规则）。证据（2026-11-15 dashboard /dashboard 实测）：`a` 包裹 `button` 的「放权与护栏」「去处理」链接聚焦后无任何焦点指示且一个操作两次 Tab 停靠（`components/dashboard/RoleFocusCard.tsx#L152-L156`、`#L194-L198`、`#L248-L252`）；`global.css` 的链接与 `Link` 无 `:focus-visible` 规则。（2026-11-15 落地：新增 `--ark-focus-ring` token 与全局焦点环；antd 焦点环改走 `colorPrimaryBorder`；RoleFocusCard 5 个动作与 DashboardPage「去处理」去掉 `a>button` 包裹，一个动作一次 Tab 停靠）
- [x] **U3.2** 核心表单与表格的键盘路径、可读标签与对比度（2026-11-15：表单焦点环统一到 `--ark-focus-ring`，error/warning 环不受影响；全站 4 处 `<Link><Button/></Link>` 收口为一个动作一次 Tab，含 `/inbox` 审批「详情」）

验收：Tab 可走完主要操作且焦点始终可见；不依赖鼠标也能完成一次核心任务。

状态：✅ 已完成（U3.1 全局焦点基线 + U3.2 表单焦点环同源与双停靠收口均已落地）。遗留：U3.1 记录的 `/inbox` 行内「查看详情」双停靠已在本轮修复。

## U4 设计系统一致性

- [x] **U4.1** `scripts/check-hex.sh` 归零：裸 hex 收口到 `tokens.css`
  > 结论（2026-11-16）：实际渲染区已归零（118 行剩余全部为无挂载 `*Modal.tsx` 死代码、`agentConfigMockData.ts` 方案配色、`api/dashboard.ts` 零消费字段，判断见 U4.1.3）。「归零」按「用户可见区归零」口径关闭，不计死代码。
  > 基线 360 行 / 66 文件（`check-hex.sh` 全量输出）。单轮 8 文件上限，拆三批推进，每批一批可验证。
  - [x] **U4.1.1** 仪表盘首屏批：`DashboardPage` + `components/dashboard/*`（6 个卡片）+ `AppShell` 未读点，裸 hex 归零（证据：`check-hex.sh` 报告中这 7 个文件 32 行，其中 `#2563eb`/`#16a34a`/`#dc2626`/`#0f766e`/`#7c3aed` 恰好等于亮色 token 值，暗色下仍是亮色蓝/绿；`DashboardPage` 演示横幅写死 `#eff6ff→#dbeafe` 渐变与 `#93c5fd` 描边，暗色下变成白底浅蓝块；`StoreGoalCard` 影响预估框写死 `#fff` 白底。验收：这 7 个文件 `grep` 零裸 hex，暗色下 4 个 KPI 值为 `#60a5fa/#2dd4bf/#a78bfa/#22c55e`；强化可信）
  - [x] **U4.1.2** 其余页面批：`pages/*`（inbox / agents / orders / product / settings / setup 等）按区逐批收口，每轮一批
    > 已完成（2026-11-16，8 批）：实际渲染的 `pages/*` 裸 hex 已归零。最后一轮（第八批）收 `LiveManagementPage`「排期中」KPI、`AdvancedStrategySections`「自动触发规则」卡（暗色下由白绿亮片改深底）、两处 `var(--ark-*, #亮色)` 兜底、`global.css` 登录 iframe 信箱区（围栏豁免），全站 123 → 118；`/livestream` 与 `/agents/promotion_campaign` 亮/暗实测通过。剩余 `pages/*` 命中只有 15 个无挂载 `*Modal.tsx`（约 95 行，属死代码决策，不算体验收益）与 `agentConfigMockData.ts`（9 行，归 U4.1.3 数据侧判断）。
    > 已收口：billing 区（`pages/billing/**`，2 文件 29 行 → 0，2026-11-16）；agents 详情页本体（`AgentBuiltinTasksSection` + `RecognitionResultCard` + `ProductDraftPreview` + `ProductLaunchDraftCard` + `LoginBootstrapSessionCard` + `components/agents/EnableAllReviewModal`，6 文件 62 行 → 0，2026-11-16，基线 299 → 237）；workflow-modals 卡片批（`CompetitorIntelCard` / `LiveMonitorCard` / `CreativeLibraryCard` / `AdDashboardCard` / `FinanceReconcileCard` / `InventoryDashboardCard` / `AfterSalesQueueCard` / `CsQueueCard`，8 文件 31 行 → 0，2026-11-16，基线 237 → 206）；workflow-modals 收尾批（`PricingMonitorCard` / `CrmSegmentCard` / `ReviewMonitorCard` / `PromotionManagerCard` / `RiskScannerCard`，5 文件 10 行 → 0，2026-11-16，基线 206 → 196，卡片区已归零）；stores + promotions 批（`StoreOnboardingPage` / `CalendarView` / `PromotionManagementPage` / `PromotionList` / `CreatePromotionDrawer`，5 文件 23 行 → 0，2026-11-16，基线 196 → 173；同时修掉 4 处引用未定义 token：`--ark-bg-surface` / `--ark-bg-sink` / `--ark-text-tertiary`）；guide + reviews 批（`UsageGuideSettingsPage` 21 + `ReviewAnalysis` 6 + `ReviewManagementPage` 3，3 文件 30 行 → 0，2026-11-16，基线 173 → 143；同时修掉 5 处未定义 token：`--ark-purple-soft` / `--ark-bg-sink` / `--ark-bg-surface` / `--ark-text-secondary` / `--ark-text-tertiary`；「描述不符」洋红分类色经 `hex-audit-off` 围栏放行，理由见 `ui-iteration-log.md`）；reports + ads + models + inventory 批（`ReportsPage` 5 / `AdManagementPage` 4 / `ModelListPage` 3 / `InventoryManagementPage` 3 / `OnboardingTour` 4 / `EmptyState` 1，7 文件 20 行 → 0，2026-11-16，基线 143 → 123；客户洞察报告卡改用 `--ark-teal` 以避开「商品表现」的紫色，`EmptyState` 图标由 `#94a3b8` 改 `--ark-muted`）。
    > 末批（5 文件 5 行 → 0，2026-11-16，基线 123 → 118）：`LiveManagementPage`（「排期中」KPI 写死 `#1890ff`，暗色下发暗）、`AdvancedStrategySections`（「自动触发规则」卡写死 `#f0fdf4` 底，暗色下成白绿亮片）、`exceptionCenterColumns` 与 `InboxPage`（`var(--ark-*)` 里写亮色 hex 兜底，变量失效时静默退回亮色）、`styles/global.css`（实际是拼多多登录 iframe 信箱区 `#0b0c0f`，属主题不变区，走 `hex-audit-off` 围栏；此前记为「Agent 终端面板」有误，终端早已围栏）。核对发现 `exceptionCenterColumns` 在 `src` 内零引用（异常列表实际在 `InboxPage` 用 antd `Tag`），这行只消除审计假阳性、不产生视觉收益。
    > **未定义 token 排查（2026-11-16）**：`src` 内仍引用但 `tokens.css` 未定义的变量已收敛到 7 个，全部在未收口页面：`--ark-bg-selected` / `--ark-bg-sink` / `--ark-bg-surface` / `--ark-purple-soft` / `--ark-text-secondary` / `--ark-text-tertiary`（`pages/customerService/*`）与 `--ark-bg-subtle`（`pages/stores/StoreDetailPage`）——这类声明整条失效、界面靠浏览器兜底，属可信层欠账，随所在页面批次一并修。
    > **范围修正（2026-11-16 走查发现）**：`workflow-modals/**` 28 文件里 15 个 `*Modal.tsx` 在 `src` 内**无任何挂载点**（`grep` 外部引用数 0；`AgentConditionalCards.tsx#L30-L58` 只挂 13 张 `*Card`），改动它们没有用户可感知收益，故本批只处理真实渲染的卡片；这 15 个 Modal（含 `ABTestComparisonModal.tsx#L144-L150` 写死 `#f0f5ff` 底 + `#d6e4ff` 描边）暂不投入，留待「是否删除死代码」决策，不计入体验收益。
    > `pages/agents/agentConfigMockData.ts` 9 行含 3 行设计稿配色与 2 行被正则误命中的订单号，归 U4.1.3 数据侧统一判断。
  - [x] **U4.1.3** `api/*` 批：`api/dashboard.ts` 15 行与 `agentConfigMockData.ts` 9 行按「数据侧色值是否承载语义」逐个判断——承载语义的改引用 token（`var(--ark-*)`），纯设计稿/方案配色退化为语义命名或删除。（`styles/global.css` 已在本批归零：login showcase、Agent 终端、拼多多登录 iframe 三处均按主题不变区围栏，理由分别写在围栏注释里）
    > **判断结论（2026-11-16）**：`api/dashboard.ts` 的 15 行色值只挂在 `agentMix`、`quotaUsage` 两个字段上，`grep` 全仓零消费（`DashboardPage` 只取 `summary` 的其余字段），永不渲染——接 token 或改数据形状都不会产生任何用户可感知变化；`agentConfigMockData.ts` 的 9 行里 3 行是 CRM 客群/设计稿方案配色（内容，不是界面语义色），2 行是订单号被正则误命中。结论：不接 token、不改数据形状，随「是否删除死代码」决策一并处理，本轮不落无收益改动。
- [x] **U4.2** 间距/字号/圆角收敛，消除同语义不同值的漂移
  > **前置证据（2026-11-16 U4.3 走查，1024 精确视口）**：`/inbox` 任务行在 1024 下标题列被压到 14px 宽、正文竖排单字（3 处实测 `w:14`、`h:237~435`，整页 `docH=4095`，1440 下为 `docH=1986` 且无竖排），亮/暗两主题同样复现；页面无横向溢出，属 flex 子项缺 `min-width: 0` 的可读缺陷，建议作为 U4.2 第一个子项（先补 `min-width` / `overflow-wrap`，再收间距字号）。
  > 状态：✅ 关闭（U4.2.1 是唯一命中项——真正影响可读的是 1024 下的布局挤压而非间距数值；1440/1024 亮暗走查未再复现同语义不同值。若后续走查发现新的漂移，另立子项，不继承本项）。
  - [x] **U4.2.1** 1024 下 `/inbox` 任务行标题被压成竖排单字（证据：`src/pages/inbox/InboxPage.tsx#L1929-L1952`，标题列 `flex: 1` 与摘要段落同一 flex 行争宽，摘要 `min-content` 撑满后标题退到 14px；实测 1024 亮/暗均 `w:14 / h:237~435`、`docH=4095`，1440 `docH=1986` 正常。验收：1024 两主题下无「单字竖排」文本（`w<28 且 h>60` 的元素数为 0）、无横向溢出、整页 `docH` 回到 1440 的 1.5 倍以内（<3000）；1440 布局不回归；强化可读（2026-11-16 落地：行内改 `flexWrap` + 标题 `1 1 200px` / 摘要 `2 1 240px`，1024 下摘要与元信息自动换行，竖排 3 处 → 0，`docH` 4095 → 2842，1440 `docH` 1986 → 2004）。
- [x] **U4.3** `providers.tsx` 的 antd token 与 `tokens.css` 对齐核对（证据：2026-11-14 /inbox 走查，深色下选中 tab 文字 `rgb(34,87,203)` 对页面底 `rgb(11,17,32)` 仅 2.95:1，选中色未随主题走）；2026-11-16 `/agents/competitor_intel` 暗色复现：选中页签与其下划线、分页当前页「1」仍为 `rgb(34,87,203)`，对卡片底 `#111827` 仅 2.78:1，而 `--ark-blue` 暗色为 `#60a5fa`——同一屏里自有 token 已切换、antd 主色未切换，是「可信层」最显眼的一处不一致
  > **完成（2026-11-16）**：强调色拆成「填充（`colorPrimary` 保持 `#2563eb`，白字可读）/ 内容（暗色对齐 `--ark-blue`：`Tabs` 选中色与下划线、`Pagination` 当前页、`colorLink` 系列）」两用；分页描边补一条 token 覆盖；`index.html` 加首帧主题同步脚本消除暗色刷新白闪与半生效。1440 / 1024、亮 / 暗四组实测：选中页签与分页当前页亮 `rgb(37,99,235)` / 暗 `rgb(96,165,250)`，对比度 2.78:1 → 6.98:1。

验收：`check-hex.sh` 退出码 0；暗色模式无丢对比度的面板。

## U5 视觉质感（U1–U4 稳定后再开）

- [x] **U5.1** 仪表盘数据密度与图表可读性
  > **前置证据（2026-11-16 U5 走查，headless Chrome 精确视口 1440/1024，亮/暗各一次）**：趋势卡是仪表盘唯一需要「读图」的地方，但结论留给人自己算——两根柱各自缩放到本序列最大值（`src/components/charts/TrendBarChart.tsx#L69-L75`、`#L90-L97`），实测 7 根柱高度 125~140px，一周 GMV +8% 在图上只有 15px 差；订单量数字只在 `title` 悬浮提示里（`TrendBarChart.tsx#L101-L103`），键盘与触屏拿不到；卡片底部先给一句方法论（「按各自最大值缩放」，`DashboardPage.tsx` 趋势卡 `chart-legend`），结论缺席。默认「当日」下 KPI 是当日值、图却是 7 天（`src/api/businessDashboard.ts#L147-L172` 的 `buildTrend` 对 `today` 与 `7d` 返回同一组点），图上没有一句口径说明。
  - [x] **U5.1.1** 趋势卡结论前置（可读层）：在柱子之前给一行结论「合计 GMV / 合计单量 · 末日较首日涨跌 · 最高一天（GMV + 单量）」，30 天档换成「7 段 × 4-5 天」的同一句式；同一句同时写进图表 `aria-label`；「当日」档在图注写明「本图是近 7 天走势，与上方『今日』KPI 口径不同……柱高不可互相比」。验收：不悬浮即可读到涨跌与最好一天；「当日 / 7 日 / 30 天」三档结论句与所选口径一致；1440/1024 × 亮/暗四组无横向溢出、卡片增高 ≤ 30px（2026-11-16 落地：新增 3 个 i18n key + 改 1 个，实测三档结论句正确，趋势卡 `cardH` 333→353（+20px，四组一致），1024 的 30 天档两行 `374`，`overflowX=0`，`check-hex` 仍为 118）。
  - [x] **U5.1.2** 首屏数据密度（可读层）：1440×900 首屏（`scrollTop=0`）里没有任何经营数字——实测区块顺序为「目标与放权 `top=229` → Agent 运营台 `top=422`（`h=414`）→ 本店目标 `870` → 经营周期 `1256` → 经营 KPI 行 `1571` → 趋势卡 `1837`」，整页 `docH=2996`；1024 下 `docH=3326`，数字更远。验收：1440×900 不滚动即可读到当日 GMV / 订单 / 广告 ROI 三个当值与较上期变化，且不改变「先人后数」的现有顺序（RoleFocusCard → 运营台 → 目标 → 经营数字）；1440/1024 亮暗四组无溢出。（2026-11-16 落地：运营台卡片内新增一条快照行，1440 快照 `top=512–549 h=37`、卡底 `859<900`；1024 两行 `h=62`、`snapBottom=658`；四组 `overflowX=0`；「完整经营数字」链接可点击/键盘 Enter 滚到 KPI 行。ROI 因数据无上一周期值，按验收偏差改用「目标 x.x×」对照并在日志登记候选。）
- [x] **U5.2** 状态过渡与动效克制
  > **完成（2026-11-16）**：系统「减少动态效果」成为全站唯一动效口径。证据：全站仅 `DashboardPage.tsx#L548` 一处内联判断；`global.css` 8 处 transition 各写 160–400ms、`OnboardingTour.tsx#L140` 内联 `all 0.3s`、antd 弹层走默认 motion token、终端光标 1s 无限闪 / 同步图标 1.6s 无限转均不认偏好。落地：`global.css#L2558-L2587` 新增 reduce 媒体查询（过渡归零、hover 上浮取消、两处装饰动画停播，加载 spinner 保留）、`providers.tsx` 下发 `token.motion`、内联过渡收窄到 `width / background-color`。实测 reduce 下 1440/1024 × 亮/暗四组光标与同步图标 `none / 0s`、KPI 卡 hover 无位移、页签过渡 `1e-05s`；`overflowX=0`，`/inbox` 1024 亮色 `docH` 两种偏好均为 2842（U4.2.1 不回归）；Tab 路径未变、焦点环可见。

验收：密度提升不牺牲三问可读性；动效不阻塞操作且可被系统「减少动态效果」尊重。

> 状态：✅ U5 已完成（U5.1.1 趋势卡结论前置、U5.1.2 首屏经营快照、U5.2 减少动态效果口径统一均已落地）。

## U6 可行：业务页三态，先修「读取中被说成没有」

> **来源（2026-11-16 全站走查，dashboard / inbox / agents / orders / settings/members + AppShell，1440/1024 × 亮/暗各一次；headless Chrome 精确视口，merchant 登录）**
> 走查结论：可读层已由 U1/U5 收口、可信层由 U4 收口，**最薄弱的是「可行层」的三态**——U2.1 只给 dashboard 补了加载/失败态，其余业务页仍把「还没读到」渲染成「没有」。
>
> **证据 A（运行时，`/orders` 客户端导航后逐帧采样）**：t≈300ms 时首屏完整渲染出结论句「0 单中，AI 已自动履约 0 单，暂无需要你处理的订单」、四张 KPI 全 0（订单数 0 / 自动处理 0 / 异常数 0 / 已取消 0）、表格空态「还没有订单。店铺同步后订单会自动出现在这里。」、同步行「尚未同步」；t≈600ms 数据到达后同一屏变成「7 单中，AI 已自动履约 4 单 / 4 单需要你决定（2 单已触达发货红线）」。也就是说：**在数据到达前，界面替人下了「今天没有订单要处理」的错误判断**，而这正是核心命题要禁止的行为。
> **证据 B（静态，以下 `/orders` 行号为改动前）**：`src/pages/orders/OrderAutomationPage.tsx#L149-L151` 三个 `useQuery` 只取 `data`（默认 `[]`），从不取 `isLoading` / `isError` / `refetch`；`#L497-L515` 结论句对「0 条」无真假之分；`#L409-L428` 空态只有「全空 / 筛选空」两种，没有「读不到」；`#L482-L486` 同步时间为空时直接说「尚未同步」。同一模式也存在于 `src/pages/agents/AgentListPage.tsx#L59`、`src/pages/inbox/InboxPage.tsx#L381-L407`（14 个查询）、`src/pages/settings/MembersSettingsPage.tsx#L21`。
> **验收（每个子项通用）**：①首屏在数据到达前不出现任何「0 / 没有 / 尚未同步」结论，改为读取中；②查询失败时显示「读不出来 ≠ 没有」并提供就地重试；③真空态只在成功且确实为空时出现；④1440/1024 × 亮/暗四组无横向溢出、结论句与数字仍同源；⑤Tab 焦点路径不新增死焦点。

- [x] **U6.1** `/orders` 三态：读取中不下「没有订单」结论，失败可重试（2026-11-16 落地：`OrderAutomationPage.tsx` 三个查询改为显式取 `isLoading/isError/refetch`，加载复用 `TablePageSkeleton`、失败复用 `EmptyState` + 「重新读取」；详情见 `ui-iteration-log.md`。强化可行）
- [x] **U6.2** `/agents` 三态：列表未返回时四张指标卡先按 0 渲染，搜索无结果无专属空态（2026-11-16 落地：`AgentListPage.tsx` 查询改为显式取 `isLoading/isError/refetch` 并 `retry: 1`，加载复用 `TablePageSkeleton`、失败与真·空复用 `EmptyState` + 「重新读取 Agent」；搜索无结果给专属空态 + 「清除搜索」；指标卡与结论句改用全量目录统计，搜索只筛表格。证据原为 `AgentListPage.tsx#L59`、`#L370-L376`。强化可行）
- [x] **U6.3** `/inbox` 三态：14 个查询任一未返回或失败都表现为「全部处理完了」（证据 `InboxPage.tsx#L381-L407`、`#L1762-L1769`）（2026-11-16 落地：9 个生成条目的查询 + `auditLogs` 改为显式取 `isLoading/isError/refetch` 并 `retry: 1`，加载复用 `TablePageSkeleton`、失败复用 `EmptyState` + 「重新读取待办」；回执单独降级为页签上方说明条 + 「重新读取回执」，待办队列不因此消失。强化可行）
- [x] **U6.4** `/settings/members` 三态：antd 表格默认「暂无数据」，无加载与失败态（证据 `MembersSettingsPage.tsx#L21`、`#L59`）（2026-11-16 落地：查询改为显式取 `isLoading/isError/refetch` 并 `retry: 1`，加载复用 `TablePageSkeleton`、失败复用 `EmptyState` +「重新读取成员」、真·空复用 `EmptyState` +「邀请成员」并复用同一邀请弹窗；四组实测无「暂无数据」，详情见 `ui-iteration-log.md`。强化可行）

验收：任一核心页在无数据、慢加载、接口失败时都有明确下一步，且不会用「0 / 空」冒充结论。

状态：✅ 已完成（U6.1 `/orders`、U6.2 `/agents`、U6.3 `/inbox`、U6.4 `/settings/members` 三态均已落地；核心业务页不再把「读取中」说成「没有」）。

## U7 可行：U6 之后仍会说错话的地方（设置子页三态 + 全局控件焦点）

> **来源（2026-11-16 全站走查第二轮：dashboard / inbox / agents / orders / settings/{members,notifications,audit-logs,billing} / products / stores + AppShell 导航，1440/1024 × 亮/暗，headless Chrome 精确视口 + Tab 逐站采样）**
> 走查结论：U6 已把「核心业务页」的读取态收口，但同一条缺陷在设置子页与 AppShell 头部还在；这三处都属于可行层（三态 / 键盘焦点），本轮起按证据强弱逐个收口。
>
> **证据 A（`/settings/notifications` 静态）**：`src/pages/settings/NotificationsSettingsPage.tsx#L34` 只取 `data = []`，不取 `isLoading/isError/refetch`；`#L160-L173` 在 `channels.length === 0` 时直接渲染「还没有通知渠道，添加后即可接收事件推送」的 Alert。`notificationsApi.listChannels` 走 `mockDelay`，所以每次进页面都会先出现一句假结论；查询失败时这句假结论会永久停留，矩阵只剩「事件」一列、没有任何通道列，读起来像「通知系统空的」。
> **证据 B（`/settings/audit-logs` 静态）**：`src/pages/audit/AuditLogsPage.tsx#L54` 三个查询都只取 `data = []`；`#L203-L208` 的分段计数直接由数据派生，读取中会渲染成「全部 (0) / 审批 (0) / …」，与「没有审计记录」无法区分；失败时同样静默为 0。
> **证据 C（AppShell 键盘，1440 亮色 Tab 第 3 站）**：`src/app/layout/AppShell.tsx#L556-L571` 的店铺范围 `Select` 聚焦后 `activeElement` 是 `.ant-select-selection-search-input`，计算样式 `outline: none 3px`、`box-shadow: none`，包装层也没有 `ant-select-focused`，边框仍是默认 `rgb(219,227,239)`——**每个页面顶部的这个控件键盘聚焦完全不可见**，而它决定全站数字的口径（全部店铺 / 单店）。同一次 Tab 采样里其余 21 站均有可见焦点环。
>
> **验收（每个子项通用）**：①读取中不出现「还没有 / 0」这类结论，改为骨架；②失败时明写「读不出来 ≠ 没有」并就地重试；③真空态只在成功且确实为空时出现；④1440/1024 × 亮/暗四组无横向溢出；⑤键盘焦点可见、Tab 路径不新增死焦点。

- [x] **U7.1** `/settings/notifications` 三态：读取中不声称「还没有通知渠道」，失败可重试（证据 A；强化可行）——2026-11-16 完成：读取中 = 页头 + 矩阵卡内骨架，失败 = 「通知渠道没读出来，这不代表没有配置」+「重新读取渠道」就地 refetch，只有成功且确实为空才显示「还没有通知渠道」（且不再渲染空矩阵）。验证见 `ui-iteration-log.md` U7.1 节。
- [ ] **U7.2** `/settings/audit-logs` 三态：分段计数在读取中不渲染成「全部 (0)」（证据 B；强化可行）
- [ ] **U7.3** AppShell 店铺范围键盘焦点不可见（证据 C；强化可行）

验收：任一设置子页在慢加载 / 接口失败时都说明「读不出来」，AppShell 头部任一键盘可达控件都有可见焦点。

状态：🔄 进行中（U7.1 已完成；U7.2 / U7.3 待做）

## 附加任务（用户直接指派）

> 不计入 U 编号，不占用「一轮一个子项」的节奏；但同样走三道门（目的 / 数据 / 验证），并写进 `ui-iteration-log.md`。已完成项保留在此，避免后续轮次重复投入。

- [x] **A1** 6 个业务页的页头统计方块尺寸统一（2026-11-16 完成，强化可信）
  - 覆盖：业务运营 - 促销活动 `/promotions`、广告投放 `/ads`、库存管理 `/inventory`、直播管理 `/livestream`；平台设置 - 模型中心 `/models`；套餐与账单 - 财务台账 - 用量与账单 `/billing?tab=usage`。
  - 证据（改前）：四套实现口径——自定义 `StatBox`（11px/20px、居中）、antd `Statistic`（14px、值 20/24 混用、同行卡片不等高、1024 下末块被拉宽）、`MetricCard`（24px、gutter 16）、手写 `Card` + `MetricCard`（18/20px 混排）。
  - 落地：`src/components/metrics/MetricCard.tsx` 新增 `StatTile`；`src/styles/global.css#L383-L540` 新增 `.stat-grid-3/4/5/6` 与 `.stat-tile*`（96px 固定高、标签 12px、值 22px、padding `12px 16px`、图标占位对齐）。
  - 验收：六页 × 1440/1024 × 亮/暗 24 组全部 96px 高、22px 值、12px 标签、组内等宽、无裁切、无横向溢出；`npm run build` 通过，`check-hex` 118 行持平。

## 状态写法

- 子项完成即勾选；一个 U 项全部勾选后把状态改为 ✅ 已完成，进行中改为 🔄 进行中。
- 每轮只允许改动与当前子项直接相关的文件，避免顺手重构。
- 新增 U 项必须带证据（文件位置/行号或走查现象）、验收标准、强化了哪一层。

## 每轮固定输入

仓库根 `AGENTS.md` → `README.md` → `product-design.md` → 本文（取顶部未完成项）→ `ui-iteration-log.md` 最近三节 → 相关页面与组件代码 → `roadmap.md`（仅当前页相关的功能口径）。

## 三道门（任一不过就停止并记录）

1. **目的门**：本轮必须强化可读 / 可行 / 可信之一，并写明是哪一层。
2. **数据门**：复用现有 domain 类型与 Mock API；界面上每个数字可回溯；颜色只用 token。
3. **验证门**：`npm run build` 通过；`scripts/check-hex.sh` 通过；亮/暗双主题与 1440/1024 两档走查；同步更新 `ui-iteration-log.md` 与本文状态。

## 每轮结束前的对齐三问

- 这轮让人少解读了什么？
- 这轮让人少点了几下？
- 这轮如果改错了，人能在界面哪里一眼看出来并撤回？

三问有一问答不上来，本轮不算完成。
