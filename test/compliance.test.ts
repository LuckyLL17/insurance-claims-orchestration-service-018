import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';
import { computeDeadlines } from '../src/domain/deadline';
import { DeadlineRecord } from '../src/domain/deadline';

const make = (reportedAt: string, channel = 'agent') => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: reportedAt, reportedAt, channel, participants: [], loss: { currency: 'CNY', gross: 5000 } }, 'test');
  return { app, id: claim.id };
};
const byKind = (list: DeadlineRecord[], kind: string, cycle = 0) => list.find((d) => d.kind === kind && d.cycle === cycle)!;

test('material notice clock skips weekends and statutory holidays', () => {
  const { app, id } = make('2026-09-30T02:00:00Z'); // 周三 10:00 上海
  const notice = byKind(app.compliance.deadlines(id, new Date('2026-10-01T00:00:00Z')), 'material_notice');
  assert.equal(notice.dueLocalDate, '2026-10-12'); // 国庆假期 + 周末顺延，10-08/09/12 三个工作日
  assert.equal(notice.dueAt, '2026-10-12T15:59:59.999Z'); // 当地日终对应的 UTC 时刻
  assert.equal(notice.timezone, 'Asia/Shanghai');
  assert.equal(notice.status, 'on_track');
  assert.match(notice.basis, /2026\.10\/CN-AUTO-MATERIAL-NOTICE/);
});

test('mobile channel tightens the material notice deadline', () => {
  const { app, id } = make('2026-10-08T02:00:00Z', 'mobile');
  const notice = byKind(app.compliance.deadlines(id, new Date('2026-10-08T03:00:00Z')), 'material_notice');
  assert.equal(notice.rule.ruleId, 'CN-AUTO-MOBILE-MATERIAL-NOTICE');
  assert.equal(notice.dueLocalDate, '2026-10-09');
});

test('document waits pause the first-decision clock and are recorded with reasons', () => {
  const { app, id } = make('2026-10-08T02:00:00Z');
  app.claims.addEvent(id, 'documents.requested', { kinds: ['police-report'] }, 'adjuster', undefined, '2026-10-10T02:00:00Z');
  app.claims.addEvent(id, 'documents.received', { kinds: ['police-report'] }, 'adjuster', undefined, '2026-10-15T02:00:00Z');
  const decision = byKind(app.compliance.deadlines(id, new Date('2026-10-16T00:00:00Z')), 'first_decision');
  assert.equal(decision.pausedDays, 6); // 10-10 至 10-15 六个当地日
  assert.equal(decision.dueLocalDate, '2026-11-13'); // 未暂停应为 11-07
  assert.equal(decision.pauses.length, 1);
  assert.equal(decision.pauses[0].reason, 'awaiting claimant documents');
  assert.ok(decision.delayReasons.some((reason) => reason.includes('awaiting claimant documents')));
  const notice = byKind(app.compliance.deadlines(id, new Date('2026-10-16T00:00:00Z')), 'material_notice');
  assert.equal(notice.status, 'met'); // 10-10 发出补件通知，早于 10-12 截止
});

test('reopening a claim restarts pausable deadlines in a new cycle and keeps history', () => {
  const { app, id } = make('2026-10-08T02:00:00Z');
  app.claims.addEvent(id, 'adjustment.approved', { approvedMinor: 100000, requiredEvidence: [] }, 'adjuster', undefined, '2026-10-20T02:00:00Z');
  app.claims.addEvent(id, 'claim.reopened', { reason: 'new evidence' }, 'adjuster', undefined, '2026-10-25T02:00:00Z');
  const deadlines = app.compliance.deadlines(id, new Date('2026-10-26T00:00:00Z'));
  assert.equal(byKind(deadlines, 'first_decision', 0).status, 'met');
  const restarted = byKind(deadlines, 'first_decision', 1);
  assert.equal(restarted.anchor.type, 'claim.reopened');
  assert.equal(restarted.dueLocalDate, '2026-11-24');
  assert.equal(restarted.status, 'on_track');
  assert.equal(byKind(deadlines, 'payment', 0).dueLocalDate, '2026-10-30'); // 核定后 10 个自然日
});

test('anchors near midnight use the region local date, not the UTC date', () => {
  const { app, id } = make('2026-10-08T16:30:00Z'); // 上海时间已是 10-09 00:30
  const notice = byKind(app.compliance.deadlines(id, new Date('2026-10-09T00:00:00Z')), 'material_notice');
  assert.equal(notice.dueLocalDate, '2026-10-14'); // 10-09 当地周五，次日起 10-12/13/14 三个工作日
});

test('due-soon notifications are idempotent and breaches escalate by ladder', () => {
  const { app, id } = make('2026-10-08T02:00:00Z');
  const first = app.compliance.scan(id, new Date('2026-11-06T00:00:00Z'));
  assert.deepEqual(first.notifications.map((d) => d.kind), ['first_decision']);
  assert.deepEqual(first.escalations.map((e) => [e.deadlineId, e.level]), [[`${id}:material_notice:0`, 'L3']]); // 材料通知已逾期 23 天，直接升到最高级
  const again = app.compliance.scan(id, new Date('2026-11-06T00:00:00Z')); // 重复扫描不产生重复通知
  assert.equal(again.notifications.length + again.escalations.length, 0);
  app.compliance.scan(id, new Date('2026-11-09T00:00:00Z'));
  app.compliance.scan(id, new Date('2026-11-13T00:00:00Z'));
  const decision = byKind(app.compliance.deadlines(id, new Date('2026-11-13T00:00:00Z')), 'first_decision');
  assert.equal(decision.status, 'breached');
  assert.deepEqual(decision.escalations.map((e) => e.level), ['L1', 'L2']);
  assert.ok(decision.notifications.length >= 1);
});

test('batch review records outcomes and stays consistent with event replay', () => {
  const { app, id } = make('2026-10-08T02:00:00Z');
  const now = new Date('2026-11-13T00:00:00Z');
  app.compliance.scan(id, now);
  const reviewed = app.compliance.reviewBatch({ outcome: 'waived', reason: 'regulator-approved extension' }, 'compliance-officer', now);
  assert.ok(reviewed[0].reviewed.includes(`${id}:first_decision:0`));
  const decision = byKind(app.compliance.deadlines(id, now), 'first_decision');
  assert.equal(decision.review?.outcome, 'waived');
  assert.ok(decision.delayReasons.some((reason) => reason.includes('regulator-approved extension')));
  const replayed = app.replay.execute(id); // 重放同一事件流 + 同一 now，投影结果必须一致
  const recomputed = computeDeadlines(replayed.events, { claimId: id, now, book: app.compliance.book, calendar: app.compliance.calendar });
  assert.deepEqual(recomputed, app.compliance.deadlines(id, now));
  const timeline = app.compliance.timeline(id, now);
  assert.ok(timeline.entries.some((entry) => entry.label === 'first_decision#0.due'));
  assert.deepEqual([...timeline.entries].sort((a, b) => a.at.localeCompare(b.at)), timeline.entries);
  assert.ok(app.compliance.board(now, 'breached').every((d) => d.status === 'breached'));
});

test('late payment is met_late with delay reasons; complaints get their own clock', () => {
  const { app, id } = make('2026-10-08T02:00:00Z');
  app.claims.addEvent(id, 'adjustment.approved', { approvedMinor: 100000, requiredEvidence: [] }, 'adjuster', undefined, '2026-10-08T02:00:00Z');
  app.claims.addEvent(id, 'payment.settled', { payment: { id: 'p1', kind: 'settlement', amount: { currency: 'CNY', minor: 100000 }, sourceId: 's1', status: 'posted', createdAt: '2026-10-20T02:00:00Z' } }, 'pay', undefined, '2026-10-20T02:00:00Z');
  app.claims.addEvent(id, 'complaint.received', { complaintId: 'C-1', detail: 'slow service' }, 'api', undefined, '2026-10-08T02:00:00Z');
  app.claims.addEvent(id, 'complaint.responded', { complaintId: 'C-1' }, 'api', undefined, '2026-10-20T02:00:00Z');
  const deadlines = app.compliance.deadlines(id, new Date('2026-10-21T00:00:00Z'));
  const payment = byKind(deadlines, 'payment');
  assert.equal(payment.dueLocalDate, '2026-10-18');
  assert.equal(payment.status, 'met_late');
  assert.ok(payment.delayReasons.some((reason) => reason.includes('exceeded')));
  const complaint = byKind(deadlines, 'complaint_response');
  assert.equal(complaint.dueLocalDate, '2026-10-23');
  assert.equal(complaint.status, 'met');
});

test('frozen rule versions keep reported claims on their original deadlines', () => {
  const { app, id } = make('2026-10-08T02:00:00Z');
  app.rules.publish('2026.11', []);
  app.compliance.book.publish('2026.11', [
    { region: '*', lineOfBusiness: '*', specs: [
      { ruleId: 'NEW-MATERIAL-NOTICE', kind: 'material_notice', days: 10, dayType: 'business', pausable: false, warnBeforeDays: 1, resetsOnReopen: false },
      { ruleId: 'NEW-FIRST-DECISION', kind: 'first_decision', days: 60, dayType: 'calendar', pausable: true, warnBeforeDays: 3, resetsOnReopen: true },
      { ruleId: 'NEW-PAYMENT', kind: 'payment', days: 20, dayType: 'calendar', pausable: false, warnBeforeDays: 2, resetsOnReopen: true },
      { ruleId: 'NEW-COMPLAINT', kind: 'complaint_response', days: 30, dayType: 'calendar', pausable: false, warnBeforeDays: 2, resetsOnReopen: false },
    ] },
  ]);
  const later = app.claims.create({ policyId: 'P-100', lossAt: '2026-10-08T02:00:00Z', reportedAt: '2026-10-08T02:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 5000 } }, 'test');
  const now = new Date('2026-10-09T00:00:00Z');
  assert.equal(byKind(app.compliance.deadlines(id, now), 'material_notice').rule.version, '2026.10');
  assert.equal(byKind(app.compliance.deadlines(id, now), 'material_notice').dueLocalDate, '2026-10-13');
  assert.equal(byKind(app.compliance.deadlines(later.id, now), 'material_notice').rule.version, '2026.11');
  assert.equal(byKind(app.compliance.deadlines(later.id, now), 'material_notice').dueLocalDate, '2026-10-22');
});
