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
- 监管时限与合规留痕：按地区/险种/渠道计算材料通知、首次决定、补偿支付、投诉响应等法定截止时间
- 法定时钟区分工作日、节假日、暂停计时与重新起算，支持规则版本冻结与时区边界
- 截止临近通知、逾期分级升级、案件级合规时间线与批量复核

## 合规接口示例

```bash
curl http://localhost:4100/claims/<id>/compliance            # 全部法定时限及留痕
curl http://localhost:4100/claims/<id>/compliance/timeline   # 案件级合规时间线
curl -X POST http://localhost:4100/claims/<id>/compliance/scan -d '{"now":"2026-11-01T00:00:00Z"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/claims/<id>/complaints -d '{"complaintId":"C-1"}' -H 'content-type: application/json'
curl -X POST http://localhost:4100/compliance/review-batch -d '{"outcome":"waived","reason":"regulator-approved"}' -H 'content-type: application/json'
curl 'http://localhost:4100/compliance/deadlines?status=breached'
```

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

- `src/domain`：理赔领域模型、规则、账本、证据、风险图谱、任务租约、法定时钟与监管时限规则
- `src/application`：事件存储、案件编排、支付、风险、任务和重放用例
- `src/infrastructure`：可替换的内存存储实现
- `src/http`：无框架 HTTP 路由和 JSON API
- `src/test`：跨模块行为测试
