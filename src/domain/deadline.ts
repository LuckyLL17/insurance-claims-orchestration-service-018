// 截止时间投影：从案件事件流纯函数式地推导每一条法定时限的完整留痕。
// 输入仅为（事件流, 规则版本, 日历, 评估时刻 now），因此与现有事件重放天然一致：
// 重放到同一事件序列、传入同一 now，必然得到同样的截止时间与状态。

import { DomainEvent } from './types';
import { ClockCalendar, LocalDate, addDays, endOfDayUtc, localDateOf, localKey, regionTimezone, startOfDayUtc } from './compliance-clock';
import { DeadlineKind, DeadlineRuleBook, DeadlineSpec } from './deadline-rules';

export interface PauseInterval { start: string; end?: string; reason: string; source: 'documents' | 'manual'; kinds?: DeadlineKind[]; }
export interface DeadlineNotice { at: string; warnBeforeDays: number; }
export interface DeadlineEscalation { at: string; level: string; assignee: string; overdueDays: number; }
export interface DeadlineReview { outcome: 'confirmed' | 'waived'; reason: string; actor: string; at: string; }

export interface DeadlineRecord {
  id: string;                 // 稳定 ID：claimId:kind:cycle，重开产生新周期
  claimId: string;
  kind: DeadlineKind;
  cycle: number;
  anchor: { eventId: string; type: string; occurredAt: string };
  rule: { version: string; ruleId: string; days: number; dayType: string; pausable: boolean; warnBeforeDays: number };
  basis: string;              // 计算依据（人读）
  region: string;
  timezone: string;
  pauses: PauseInterval[];    // 已扣除的暂停区间
  pausedDays: number;
  dueAt: string;              // UTC 截止时刻（当地自然日结束）
  dueLocalDate: string;       // 当地截止日 YYYY-MM-DD
  fulfilledBy?: { eventId: string; type: string; occurredAt: string };
  status: 'on_track' | 'due_soon' | 'met' | 'met_late' | 'breached' | 'superseded';
  delayReasons: string[];
  notifications: DeadlineNotice[];
  escalations: DeadlineEscalation[];
  review?: DeadlineReview;
  computedAt: string;
}

export interface ComputeContext { claimId: string; now: Date; book: DeadlineRuleBook; calendar: ClockCalendar; }

const DAY_MS = 86_400_000;
const MAX_ITERATED_DAYS = 3660;

interface Anchor { eventId: string; type: string; occurredAt: string; key?: string; }

export function computeDeadlines(events: DomainEvent[], ctx: ComputeContext): DeadlineRecord[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const reported = sorted.find((event) => event.type === 'claim.reported');
  if (!reported) return [];
  const reportPayload = reported.payload as any;
  const region = reportPayload.region ?? 'CN';
  const lineOfBusiness = reportPayload.lineOfBusiness ?? 'auto';
  const channel = reportPayload.channel ?? 'default';
  const snapshot = sorted.find((event) => event.type === 'policy.snapshot.created');
  const version = (snapshot?.payload as any)?.ruleSnapshot?.version ?? ctx.book.active();
  const specs = ctx.book.resolve(version, region, lineOfBusiness, channel);
  const tz = regionTimezone(region);
  const pauses = collectPauses(sorted);
  const nowIso = ctx.now.toISOString();

  const records: DeadlineRecord[] = [];
  for (const spec of specs) {
    const anchors = anchorsFor(spec.kind, sorted, reportPayload);
    anchors.forEach((anchor, index) => {
      const next = anchors[index + 1];
      const windowEnd = next?.occurredAt;
      const fulfill = findFulfillment(spec.kind, sorted, anchor, windowEnd, spec);
      const superseded = !fulfill && spec.resetsOnReopen && !!next;
      records.push(buildRecord(ctx, spec, anchor, index, fulfill, superseded, pauses, sorted, { region, tz, version, nowIso }));
    });
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

// 报案锚点使用 payload.reportedAt（法定报案时刻），其余锚点使用事件受理时刻。
function anchorsFor(kind: DeadlineKind, events: DomainEvent[], reportPayload: any): Anchor[] {
  const reported = events.find((event) => event.type === 'claim.reported')!;
  const reportAnchor: Anchor = { eventId: reported.id, type: 'claim.reported', occurredAt: reportPayload.reportedAt ?? reported.occurredAt };
  if (kind === 'material_notice') return [reportAnchor];
  if (kind === 'first_decision') return [reportAnchor, ...events.filter((event) => event.type === 'claim.reopened').map((event) => ({ eventId: event.id, type: event.type, occurredAt: event.occurredAt }))];
  if (kind === 'payment') return events.filter((event) => event.type === 'adjustment.approved').map((event) => ({ eventId: event.id, type: event.type, occurredAt: event.occurredAt }));
  return events.filter((event) => event.type === 'complaint.received').map((event) => ({ eventId: event.id, type: event.type, occurredAt: event.occurredAt, key: (event.payload as any)?.complaintId ?? event.id }));
}

function findFulfillment(kind: DeadlineKind, events: DomainEvent[], anchor: Anchor, windowEnd: string | undefined, spec: DeadlineSpec): Anchor | undefined {
  const within = (event: DomainEvent) => event.occurredAt > anchor.occurredAt && (!windowEnd || event.occurredAt <= windowEnd);
  if (kind === 'material_notice') { const hit = events.find((event) => event.type === 'documents.requested' && within(event)); return hit && { eventId: hit.id, type: hit.type, occurredAt: hit.occurredAt }; }
  if (kind === 'first_decision') { const hit = events.find((event) => (event.type === 'adjustment.approved' || event.type === 'claim.rejected') && within(event)); return hit && { eventId: hit.id, type: hit.type, occurredAt: hit.occurredAt }; }
  if (kind === 'payment') { const hit = events.find((event) => event.type === 'payment.settled' && within(event)); return hit && { eventId: hit.id, type: hit.type, occurredAt: hit.occurredAt }; }
  const hit = events.find((event) => event.type === 'complaint.responded' && within(event) && ((event.payload as any)?.complaintId ?? '') === (anchor.key ?? ''));
  return hit && { eventId: hit.id, type: hit.type, occurredAt: hit.occurredAt };
}

// 暂停区间：补件期间（documents.requested → 补齐）与显式暂停/恢复事件。
function collectPauses(events: DomainEvent[]): PauseInterval[] {
  const pauses: PauseInterval[] = [];
  const pending = new Set<string>();
  let docStart: DomainEvent | undefined;
  let manualStart: DomainEvent | undefined;
  for (const event of events) {
    const payload = event.payload as any;
    if (event.type === 'documents.requested') {
      for (const kind of payload?.kinds ?? ['general']) pending.add(kind);
      if (!docStart) docStart = event;
    }
    if (event.type === 'documents.received') {
      for (const kind of payload?.kinds ?? []) pending.delete(kind);
      if (pending.size === 0 && docStart) { pauses.push({ start: docStart.occurredAt, end: event.occurredAt, reason: 'awaiting claimant documents', source: 'documents' }); docStart = undefined; }
    }
    if (event.type === 'deadline.paused' && !manualStart) manualStart = event;
    if (event.type === 'deadline.resumed' && manualStart) {
      pauses.push({ start: manualStart.occurredAt, end: event.occurredAt, reason: payload?.reason ?? (manualStart.payload as any)?.reason ?? 'manual clock pause', source: 'manual', kinds: (manualStart.payload as any)?.kinds });
      manualStart = undefined;
    }
  }
  if (docStart) pauses.push({ start: docStart.occurredAt, reason: 'awaiting claimant documents', source: 'documents' });
  if (manualStart) pauses.push({ start: manualStart.occurredAt, reason: (manualStart.payload as any)?.reason ?? 'manual clock pause', source: 'manual', kinds: (manualStart.payload as any)?.kinds });
  return pauses;
}

function buildRecord(ctx: ComputeContext, spec: DeadlineSpec, anchor: Anchor, cycle: number, fulfill: Anchor | undefined, superseded: boolean, pauses: PauseInterval[], events: DomainEvent[], env: { region: string; tz: string; version: string; nowIso: string }): DeadlineRecord {
  const id = `${ctx.claimId}:${spec.kind}:${cycle}`;
  const applicable = spec.pausable ? pauses.filter((pause) => !pause.kinds || pause.kinds.includes(spec.kind)) : [];
  const horizon = fulfill?.occurredAt ?? env.nowIso;
  const windowPauses = applicable
    .filter((pause) => pause.start <= horizon && (pause.end ?? env.nowIso) >= anchor.occurredAt)
    .map((pause) => ({ ...pause, start: pause.start < anchor.occurredAt ? anchor.occurredAt : pause.start, end: pause.end && pause.end <= horizon ? pause.end : horizon }));
  const due = computeDue(anchor.occurredAt, spec, applicable, env, ctx);
  const own = events.filter((event) => (event.payload as any)?.deadlineId === id);
  const notifications: DeadlineNotice[] = own.filter((event) => event.type === 'deadline.notification').map((event) => ({ at: event.occurredAt, warnBeforeDays: (event.payload as any).warnBeforeDays }));
  const escalations: DeadlineEscalation[] = own.filter((event) => event.type === 'deadline.escalated').map((event) => ({ at: event.occurredAt, level: (event.payload as any).level, assignee: (event.payload as any).assignee, overdueDays: (event.payload as any).overdueDays }));
  const reviewEvents = own.filter((event) => event.type === 'deadline.reviewed');
  const lastReview = reviewEvents.at(-1);

  let status: DeadlineRecord['status'];
  if (superseded) status = 'superseded';
  else if (fulfill) status = fulfill.occurredAt <= due.dueAt ? 'met' : 'met_late';
  else if (env.nowIso > due.dueAt) status = 'breached';
  else status = new Date(due.dueAt).getTime() - new Date(env.nowIso).getTime() <= spec.warnBeforeDays * DAY_MS ? 'due_soon' : 'on_track';

  const delayReasons = [
    ...windowPauses.map((pause) => `${pause.reason} (${pause.source}, ${pauseDays(pause, env.tz)}d)`),
    ...(status === 'met_late' || status === 'breached' ? [`statutory due ${due.dueLocalDate} exceeded`] : []),
    ...(lastReview ? [`reviewed ${(lastReview.payload as any).outcome}: ${(lastReview.payload as any).reason}`] : []),
  ];

  const basis = [
    `规则 ${env.version}/${spec.ruleId}：自 ${anchor.type}(${anchor.occurredAt}) 次日起算 ${spec.days} 个${spec.dayType === 'business' ? '工作日' : '自然日'}`,
    spec.pausable ? `，可暂停，已扣除 ${due.pausedDays} 日` : '，不可暂停',
    `；地区 ${env.region}，时区 ${env.tz}，截止当地 ${due.dueLocalDate} 日终`,
  ].join('');

  return {
    id, claimId: ctx.claimId, kind: spec.kind, cycle,
    anchor, rule: { version: env.version, ruleId: spec.ruleId, days: spec.days, dayType: spec.dayType, pausable: spec.pausable, warnBeforeDays: spec.warnBeforeDays },
    basis, region: env.region, timezone: env.tz,
    pauses: windowPauses, pausedDays: due.pausedDays,
    dueAt: due.dueAt, dueLocalDate: due.dueLocalDate,
    fulfilledBy: fulfill, status, delayReasons,
    notifications, escalations,
    review: lastReview ? { outcome: (lastReview.payload as any).outcome, reason: (lastReview.payload as any).reason, actor: lastReview.actor, at: lastReview.occurredAt } : undefined,
    computedAt: env.nowIso,
  };
}

function computeDue(anchorIso: string, spec: DeadlineSpec, pauses: PauseInterval[], env: { region: string; tz: string; nowIso: string }, ctx: ComputeContext): { dueAt: string; dueLocalDate: string; pausedDays: number } {
  let current = localDateOf(anchorIso, env.tz);
  let counted = 0;
  let pausedDays = 0;
  for (let i = 0; i < MAX_ITERATED_DAYS && counted < spec.days; i++) {
    current = addDays(current, 1);
    if (spec.dayType === 'business' && !ctx.calendar.isBusinessDay(env.region, current)) continue;
    if (spec.pausable && pauses.some((pause) => dayInPause(current, pause, env.tz, env.nowIso))) { pausedDays++; continue; }
    counted++;
  }
  return { dueAt: endOfDayUtc(current, env.tz).toISOString(), dueLocalDate: localKey(current), pausedDays };
}

function dayInPause(date: LocalDate, pause: PauseInterval, tz: string, nowIso: string): boolean {
  const dayStart = startOfDayUtc(date, tz).getTime();
  const dayEnd = endOfDayUtc(date, tz).getTime();
  const start = new Date(pause.start).getTime();
  const end = new Date(pause.end ?? nowIso).getTime();
  return start <= dayEnd && end >= dayStart;
}

function pauseDays(pause: PauseInterval, tz: string): number {
  const start = localDateOf(pause.start, tz);
  const end = localDateOf(pause.end ?? pause.start, tz);
  let days = 0;
  let cursor = start;
  for (let i = 0; i < MAX_ITERATED_DAYS; i++) {
    days++;
    if (localKey(cursor) === localKey(end)) break;
    cursor = addDays(cursor, 1);
  }
  return days;
}
