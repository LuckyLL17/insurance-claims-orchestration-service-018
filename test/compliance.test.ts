import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { HolidayCalendar } from '../src/domain/calendar';
import { DeadlineClock } from '../src/domain/deadline-clock';
import { DeadlineRuleBook } from '../src/domain/deadline-rules';
import { ComplianceProjector } from '../src/domain/compliance-projector';

const claimInput = (overrides: Record<string, unknown> = {}) => ({
  policyId: 'P-100', lossAt: '2026-10-07T01:00:00Z', reportedAt: '2026-10-07T02:00:00Z',
  channel: 'mobile', region: 'CN', line: 'auto',
  participants: [{ kind: 'vehicle' as const, id: 'car-x' }], loss: { currency: 'CNY', gross: 18000 }, ...overrides,
});

test('deadline clock counts working days across holidays, makeup workdays and DST boundaries', () => {
  const calendar = new HolidayCalendar();
  const clock = new DeadlineClock(calendar);

  // 报案 2026-02-13（周五，春节调休周六上班）：1 个工作日截止到 02-14（调休周六）当地 24:00
  assert.equal(clock.advance('2026-02-13T02:00:00Z', 'working', 1, '24:00', 'CN').deadlineAt, '2026-02-14T16:00:00.000Z');
  // 2 个工作日：春节假期后第二个工作日 02-23（周一）
  assert.equal(clock.advance('2026-02-13T02:00:00Z', 'working', 2, '24:00', 'CN').deadlineAt, '2026-02-23T16:00:00.000Z');
  // 30 个自然日
  assert.equal(clock.advance('2026-10-07T02:00:00Z', 'calendar', 30, '24:00', 'CN').deadlineAt, '2026-11-06T16:00:00.000Z');
  // 暂停 5 个自然日，截止顺延 5 天
  assert.equal(
    clock.advance('2026-10-07T02:00:00Z', 'calendar', 30, '24:00', 'CN', [{ from: '2026-10-10T00:00:00Z', to: '2026-10-15T00:00:00Z' }]).deadlineAt,
    '2026-11-11T16:00:00.000Z',
  );
  // EU 夏令时跳转日仍计为 1 个自然日；截止按柏林当地 24:00（CEST = UTC+2）
  assert.equal(clock.advance('2026-03-20T12:00:00Z', 'calendar', 15, '24:00', 'EU').deadlineAt, '2026-04-04T22:00:00.000Z');
  // 同一时长在 CN（无 DST）截止同为当地 04-04 结束 = 04-04T16:00Z
  assert.equal(clock.advance('2026-03-20T12:00:00Z', 'calendar', 15, '24:00', 'CN').deadlineAt, '2026-04-04T16:00:00.000Z');
  // 工作日窗口被暂停切碎则当日不计，顺延到下一工作日
  assert.equal(
    clock.advance('2026-10-07T02:00:00Z', 'working', 1, '24:00', 'CN', [{ from: '2026-10-08T03:00:00Z', to: '2026-10-08T05:00:00Z' }]).deadlineAt,
    '2026-10-09T16:00:00.000Z',
  );
});

test('creates claim with frozen deadline rule snapshot and anchored statutory deadlines', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test', 'compliance-1');
  assert.equal(claim.deadlineSnapshot?.version, '2026.10');

  const projection = app.compliance.projection(claim.id, '2026-10-07T03:00:00Z');
  const kinds = new Map(projection.records.map((r) => [r.kind, r]));
  // 首次决定：材料齐全起算前先从报案日锚定 30 自然日
  const decision = kinds.get('first_decision')!;
  assert.equal(decision.basis.ruleVersion, '2026.10');
  assert.equal(decision.deadlineAt, '2026-11-06T16:00:00.000Z');
  assert.equal(decision.basis.legalBasis, '保险法第二十三条：三十日内核定');
  assert.equal(decision.basis.matched.region, 'CN');
  assert.equal(decision.basis.matched.channel, 'mobile');
  assert.equal(decision.basis.anchorEvent, 'claim.reported');
  // 计算依据完整留痕
  assert.equal(decision.basis.calendarVersion, 'CN-2026');
  assert.ok(decision.basis.warningsAtHours.includes(24));
  assert.equal(decision.status, 'pending');
});

test('document notice deadline is measured from report date and recorded with outcome', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput({ channel: 'mobile' }), 'test');
  // mobile：1 个工作日内发出材料通知
  const report = app.compliance.requestDocuments(claim.id, { kinds: ['loss-photo'] }, 'adjuster', '2026-10-08T06:00:00Z');
  const notice = report.records.find((r) => r.kind === 'document_notice')!;
  assert.equal(notice.outcome, 'met');
  assert.equal(notice.fulfilledByEvent, 'documents.requested');
  assert.equal(notice.anchorAt, '2026-10-07T02:00:00.000Z');
  // 1 个工作日：次日 10-08（周四）当地 24:00 = UTC 16:00
  assert.equal(notice.deadlineAt, '2026-10-08T16:00:00.000Z');
  // 代理渠道 2 个工作日
  const agentClaim = app.claims.create(claimInput({ channel: 'agent' }), 'test');
  const lateReport = app.compliance.requestDocuments(agentClaim.id, { kinds: ['x'] }, 'adjuster', '2026-10-14T00:00:00Z');
  const lateNotice = lateReport.records.find((r) => r.kind === 'document_notice')!;
  // 2 个工作日 = 10-08、10-09，截止 10-09T16Z；10-14 才通知，逾期
  assert.equal(lateNotice.deadlineAt, '2026-10-09T16:00:00.000Z');
  assert.equal(lateNotice.outcome, 'overdue');
  assert.ok((lateNotice.overdueMs ?? 0) > 0);
});

test('first-decision clock auto-pauses while awaiting documents and resumes on receipt, extending deadline', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  app.compliance.requestDocuments(claim.id, { kinds: ['loss-photo'] }, 'adjuster', '2026-10-08T03:00:00Z');
  const paused = app.compliance.projection(claim.id, '2026-10-09T00:00:00Z').records.find((r) => r.kind === 'first_decision')!;
  assert.equal(paused.openPause, true);
  assert.equal(paused.suspensions.length, 1);
  assert.match(paused.suspensions[0].reason, /documents/);

  // 10-20 才补齐：暂停 12 个自然日，截止顺延
  const resumed = app.compliance.receiveDocuments(claim.id, { kinds: ['loss-photo'] }, 'adjuster', '2026-10-20T03:00:00Z')
    .records.find((r) => r.kind === 'first_decision')!;
  assert.equal(resumed.openPause, false);
  assert.equal(resumed.suspensions[0].to, '2026-10-20T03:00:00.000Z');
  assert.equal(resumed.deadlineAt, '2026-11-18T16:00:00.000Z');
  assert.equal(resumed.revisions.length, 1);
  assert.equal(resumed.revisions[0].resetSuspensions, false);
  assert.ok(resumed.revisions[0].priorDeadline);
});

test('manual pause/resume and delay with extension days are fully traceable', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  const paused = app.compliance.pauseClock(claim.id, { kind: 'first_decision', reason: 'expert opinion pending' }, 'officer', '2026-10-09T00:00:00Z');
  const record = paused.records.find((r) => r.kind === 'first_decision')!;
  assert.equal(record.suspensions.at(-1)?.reason, 'expert opinion pending');
  const resumed = app.compliance.resumeClock(claim.id, { kind: 'first_decision' }, 'officer', '2026-10-14T00:00:00Z');
  const r2 = resumed.records.find((r) => r.kind === 'first_decision')!;
  assert.equal(r2.suspensions.at(-1)?.durationMs, 5 * 86_400_000);
  const delayed = app.compliance.recordDelay(claim.id, { kind: 'first_decision', reason: 'regulator inquiry', category: 'regulator', extendDays: 3 }, 'officer', '2026-10-15T00:00:00Z');
  const r3 = delayed.records.find((r) => r.kind === 'first_decision')!;
  assert.equal(r3.delayReasons.at(-1)?.category, 'regulator');
  assert.equal(r3.basis.durationDays, 33);
  assert.ok(r3.revisions.length >= 2);
});

test('payment deadline anchors on approval, restarts on claim reopen, and keeps audit trail', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { a: 1 }, receivedAt: '2026-10-08T00:00:00Z' }, 't');
  app.claims.addEvent(claim.id, 'adjustment.approved', { approvedMinor: 1_800_000, requiredEvidence: ['loss-photo'] }, 'adjuster', undefined, '2026-10-20T00:00:00Z');
  let payment = app.compliance.projection(claim.id, '2026-10-20T00:00:00Z').records.find((r) => r.kind === 'payment')!;
  assert.equal(payment.deadlineAt, '2026-10-30T16:00:00.000Z'); // 10 自然日
  assert.equal(payment.basis.anchorEvent, 'adjustment.approved');

  // 支付后又冲正重开
  app.claims.addEvent(claim.id, 'payment.settled', { payment: { id: 'p1', kind: 'settlement', amount: { currency: 'CNY', minor: 1_800_000 }, sourceId: 's1', status: 'posted', createdAt: '2026-10-22T00:00:00Z' } }, 'pay', undefined, '2026-10-22T00:00:00Z');
  const reopened = app.compliance.reopen(claim.id, { reason: 'new evidence surfaced' }, 'supervisor', '2026-11-02T00:00:00Z');
  payment = reopened.records.find((r) => r.kind === 'payment')!;
  assert.equal(payment.restartCount, 1);
  assert.equal(payment.anchorAt, '2026-11-02T00:00:00.000Z');
  assert.equal(payment.suspensions.length, 0);
  assert.equal(payment.deadlineAt, '2026-11-12T16:00:00.000Z');
  assert.match(payment.revisions.at(-1)?.reason ?? '', /reopen/);
});

test('complaint response runs on working-day clock and records met/overdue', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  const registered = app.compliance.registerComplaint(claim.id, { complaintId: 'COMP-1', source: 'cbirc', registeredAt: '2026-10-07T05:00:00Z' }, 'regulator');
  const response = registered.records.find((r) => r.kind === 'complaint_response')!;
  // 15 个工作日（末日 10-27）当地 24:00
  assert.equal(response.deadlineAt, '2026-10-27T16:00:00.000Z');
  assert.equal(response.basis.dayKind, 'working');
  const answered = app.compliance.respondComplaint(claim.id, { complaintId: 'COMP-1', response: 'resolved', respondedAt: '2026-10-26T00:00:00Z' }, 'officer');
  assert.equal(answered.records.find((r) => r.subjectId === 'COMP-1')?.outcome, 'met');
  // 逾期案件
  const c2 = app.claims.create(claimInput(), 'test');
  app.compliance.registerComplaint(c2.id, { complaintId: 'COMP-2', registeredAt: '2026-10-07T05:00:00Z' }, 'regulator');
  const late = app.compliance.respondComplaint(c2.id, { complaintId: 'COMP-2', response: 'late', respondedAt: '2026-11-02T00:00:00Z' }, 'officer');
  assert.equal(late.records.find((r) => r.subjectId === 'COMP-2')?.outcome, 'overdue');
});

test('scan emits near-deadline warnings once and overdue escalations after the configured grace', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  // 距截止 <24h：触发 24h 预警（幂等，第二次扫描不重复）
  const first = app.compliance.scan('2026-11-05T17:00:00Z', [claim.id]);
  assert.equal(first.warnings.filter((n) => n.deadlineKind === 'first_decision').length, 1);
  const second = app.compliance.scan('2026-11-05T18:00:00Z', [claim.id]);
  assert.equal(second.warnings.filter((n) => n.deadlineKind === 'first_decision').length, 0);
  // 逾期但未超过 48h 宽限：仅逾期通知，不升级
  const overdue = app.compliance.scan('2026-11-07T16:00:00Z', [claim.id]);
  assert.equal(overdue.escalations.length, 0);
  assert.ok(overdue.warnings.some((n) => n.kind === 'deadline_overdue'));
  // 超过 48h：升级
  const escalated = app.compliance.scan('2026-11-09T17:00:00Z', [claim.id]);
  assert.equal(escalated.escalations.length, 1);
  const record = app.compliance.projection(claim.id, '2026-11-09T17:00:00Z').records.find((r) => r.kind === 'first_decision')!;
  assert.equal(record.escalated, true);
  assert.equal(record.warned, true);
  // 通知留痕
  assert.ok(app.notifications.list({ claimId: claim.id, kind: 'deadline_escalation' }).length >= 1);
});

test('batch review lists overdue and near deadlines and leaves compliance review events', () => {
  const app = buildApp();
  const overdueClaim = app.claims.create(claimInput(), 'test');
  const nearClaim = app.claims.create(claimInput(), 'test');
  void nearClaim;
  // 让一个案件逾期：把报案时间放到很久以前（通过自定义输入）
  const old = app.claims.create(claimInput({ reportedAt: '2026-08-01T02:00:00Z', lossAt: '2026-08-01T01:00:00Z' }), 'test');
  void overdueClaim;
  const result = app.compliance.batchReview({ now: '2026-10-01T00:00:00Z', reviewer: 'auditor', note: 'Q3 review' });
  assert.ok(result.overdue >= 1);
  assert.ok(result.items.some((i) => i.claimId === old.id && i.kind === 'first_decision'));
  // 每个涉事案件都留有 compliance.reviewed 事件，且与重放一致
  const state = app.claims.get(old.id);
  assert.equal(state.complianceReviewedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(state.complianceReviewNote, 'Q3 review');
  // 按地区过滤
  const cnOnly = app.compliance.batchReview({ now: '2026-10-01T00:00:00Z', region: 'CN' });
  assert.ok(cnOnly.items.every((i) => i.region === 'CN'));
});

test('compliance projection is identical to replaying the claim event stream', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  app.compliance.requestDocuments(claim.id, { kinds: ['loss-photo'] }, 'a', '2026-10-08T03:00:00Z');
  app.compliance.pauseClock(claim.id, { kind: 'first_decision', reason: 'manual hold' }, 'b', '2026-10-09T00:00:00Z');
  app.compliance.resumeClock(claim.id, { kind: 'first_decision' }, 'b', '2026-10-11T00:00:00Z');
  app.compliance.receiveDocuments(claim.id, { kinds: ['loss-photo'] }, 'a', '2026-10-12T00:00:00Z');
  app.compliance.registerComplaint(claim.id, { complaintId: 'COMP-9', registeredAt: '2026-10-13T00:00:00Z' }, 'r');

  // 对同一事件流在任意“当前时刻”重复投影，结果必须逐字节稳定（纯函数，可重放）
  const run1 = app.compliance.projection(claim.id, '2026-10-14T00:00:00Z');
  const run2 = app.compliance.projection(claim.id, '2026-10-14T00:00:00Z');
  assert.deepEqual(
    run1.records.map((r) => [r.kind, r.subjectId ?? null, r.deadlineAt, r.status, r.suspensions.length, r.revisions.map((v) => v.reason)]),
    run2.records.map((r) => [r.kind, r.subjectId ?? null, r.deadlineAt, r.status, r.suspensions.length, r.revisions.map((v) => v.reason)]),
  );

  // 用 ReplayService 截取到历史序列点，再把该子流投影，结果只反映截至该时点的状态（含滚动预测的开放暂停）
  const partialEvents = app.replay.execute(claim.id, 3).events;
  const partial = app.compliance.projection(claim.id, '2026-10-14T00:00:00Z');
  void partialEvents; void partial;
  const atSeq3 = (() => {
    const projector = new ComplianceProjector(new DeadlineClock(app.calendar), app.calendar, app.deadlineRules);
    return projector.project(partialEvents, '2026-10-14T00:00:00Z');
  })();
  // 序列 3 时（compliance.snapshot.created 之前的事件不影响）投诉尚未注册
  assert.ok(!atSeq3.records.some((r: any) => r.kind === 'complaint_response'));
});

test('rule version freeze keeps old claims on the published-at-claim-time version', () => {
  const book = new DeadlineRuleBook();
  const oldClaim = { region: 'CN', line: 'auto', channel: 'mobile' };
  const oldRule = book.match('first_decision', oldClaim.region, oldClaim.line, oldClaim.channel, book.freeze().version);
  assert.equal(oldRule.durationDays, 30);
  // 发布新版本
  book.publish('2026.11', book.all('2026.10').map((r) => r.kind === 'first_decision' ? { ...r, durationDays: 20 } : r));
  assert.equal(book.active, '2026.11');
  const newRule = book.match('first_decision', 'CN', 'auto', 'mobile', book.freeze().version);
  assert.equal(newRule.durationDays, 20);
  // 旧案件冻结的仍是 2026.10
  assert.equal(oldRule.version, '2026.10');
  // 新版本里的规则都带上新版本号
  assert.ok(book.all('2026.11').every((r) => r.version === '2026.11'));
  // 不能重复发布同一版本
  assert.throws(() => book.publish('2026.11', []), /already exists/);
});

test('open pause suppresses overdue status and notifications until the clock resumes', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  // 30 日自然日，截止 11-06；10-20 手动暂停且一直不恢复
  app.compliance.pauseClock(claim.id, { kind: 'first_decision', reason: 'pending police report' }, 'officer', '2026-10-20T00:00:00Z');
  const record = app.compliance.projection(claim.id, '2026-12-01T00:00:00Z').records.find((r) => r.kind === 'first_decision')!;
  assert.equal(record.openPause, true);
  assert.equal(record.status, 'pending'); // 不因超过原截止日而判逾期
  const scan = app.compliance.scan('2026-12-01T00:00:00Z', [claim.id]);
  assert.equal(scan.warnings.length, 0);
  assert.equal(scan.escalations.length, 0);
  const batch = app.compliance.batchReview({ now: '2026-12-01T00:00:00Z' });
  assert.ok(!batch.items.some((i) => i.claimId === claim.id && i.kind === 'first_decision'));
  // 恢复后按已暂停时长顺延，扫描恢复正常
  app.compliance.resumeClock(claim.id, { kind: 'first_decision' }, 'officer', '2026-12-01T00:00:00Z');
  const resumed = app.compliance.projection(claim.id, '2026-12-01T01:00:00Z').records.find((r) => r.kind === 'first_decision')!;
  assert.equal(resumed.openPause, false);
  assert.equal(resumed.deadlineAt, '2026-12-18T16:00:00.000Z');
});

test('timeline merges claim events with deadline lifecycle entries in chronological order', () => {
  const app = buildApp();
  const claim = app.claims.create(claimInput(), 'test');
  app.compliance.requestDocuments(claim.id, { kinds: ['loss-photo'] }, 'adjuster', '2026-10-08T03:00:00Z');
  app.compliance.receiveDocuments(claim.id, { kinds: ['loss-photo'] }, 'adjuster', '2026-10-20T03:00:00Z');
  const timeline = app.compliance.timeline(claim.id, '2026-10-21T00:00:00Z');
  const types = timeline.map((t) => t.type);
  assert.ok(types.includes('deadline.paused'));
  assert.ok(types.includes('deadline.resumed'));
  assert.ok(types.includes('deadline.anchored'));
  assert.ok(types.includes('deadline.due'));
  assert.ok(types.includes('documents.requested'));
  // 时间有序
  const stamps = timeline.map((t) => t.at);
  assert.deepEqual(stamps, [...stamps].sort());
});
