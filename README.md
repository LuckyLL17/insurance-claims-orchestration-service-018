# 保险理赔案件编排与反欺诈调查服务

一个可本地运行的 Node.js + TypeScript 纯后端项目。系统不依赖 Docker、数据库或第三方服务，使用内存事件存储模拟真实的理赔领域基础设施，适合继续扩展 0-1、Feature、Bug 和综合题。

## 核心能力

- 保单版本与事故发生时间的责任快照
- 报案、补件、查勘、核验、理算、支付、结案状态机
- 事件溯源、幂等事件接收、乱序事件重放
- 可冻结、发布和回滚的规则版本
- 证据版本链、哈希、引用快照和审计轨迹
- 分阶段支付、追回、冲正和赔付上限账本
- 设备、车辆、人员、维修厂、账户的风险关联图
- 调查任务租约、过期提交保护和重派
- 单案件及跨案件风险解释
- 监管时限与合规留痕：法定截止时间计算、暂停计时/重新起算、规则版本冻结、临近/逾期/升级事件

## 监管时限与合规留痕

- 四类法定截止时间：材料通知（`document_notice`）、首次决定（`first_decision`）、补偿支付（`payment`）、投诉响应（`complaint_response`）
- 规则按 **地区 / 险种 / 报案渠道** 选择最具体版本；报案时冻结规则快照（`compliance.snapshot.created`），新版本不影响存量案件
- 时钟区分工作日（法定节假日、周末不计时，调休上班日计时）与自然日；支持当地办事时间窗口、暂停计时（自动/手动）、恢复顺延、重新起算与延误原因登记
- 时区边界按 IANA 处理（内置 Intl full-icu，自动覆盖夏令时）；内置 CN / HK / EU / DEFAULT 日历，可注册自定义地区
- 每个截止时间记录计算依据（规则、法条、锚点事件、匹配维度）、暂停区间、延误原因、修订链、最终结果（按时/逾期）
- 所有合规状态由 **ComplianceProjector 从同一案件事件流确定性投影**，与 `ReplayService` 重放完全一致；临近预警与逾期升级先落事件（幂等）再出通知
- 案件重开（`claim.reopened`）以重开时点重新起算并清空暂停、保留历史修订；开放暂停期间不判逾期、不发通知
- 接口：案件合规报告与时间线、扫描（`POST /compliance/scan`）、逾期升级、批量复核（`POST /compliance/batch-review`）、通知留痕（`GET /notifications`）

## 启动

```bash
npm install
npm run build
npm test
npm start
```

服务默认监听 `http://localhost:4100`，可用 `PORT=4200 npm start` 修改端口。

## 示例

```bash
curl http://localhost:4100/health
curl -X POST http://localhost:4100/claims \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-claim-1' \
  -d '{"policyId":"P-100","lossAt":"2026-10-06T08:00:00Z","reportedAt":"2026-10-06T09:00:00Z","participants":[{"kind":"person","id":"person-1"},{"kind":"vehicle","id":"car-1"}],"loss":{"currency":"CNY","gross":18000},"channel":"mobile"}'
```

## 目录说明

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱和任务租约
- `src/application`：事件存储、案件编排、支付、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
