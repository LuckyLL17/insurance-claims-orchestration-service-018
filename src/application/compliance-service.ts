import { EventStore } from './event-store';
import { ClaimService } from './claim-service';
import { ComplianceProjector, ComplianceProjection } from '../domain/compliance-projector';
import { NotificationLog, Notification } from './notification-log';
import { DeadlineKind, DeadlineRecord, DomainEvent } from '../domain/types';
import { iso } from '../domain/ids';

export interface TimelineEntry {
  at: string;
  eventId?: string;
  sequence?: number;
  source: 'claim_event' | 'deadline';
  type: string;
  actor?: string;
  summary: string;
  deadlineKind?: DeadlineKind;
}

export interface ComplianceReport {
  claimId: string;
  region: string;
  line: string;
  channel: string;
  ruleVersion?: string;
  frozenAt?: string;
  generatedAt: string;
  records: DeadlineRecord[];
  timeline: TimelineEntry[];
  notifications: Notification[];
}

export interface BatchReviewItem {
  claimId: string;
  region: string;
  line: string;
  status: DeadlineRecord['status'];
  kind: DeadlineKind;
  subjectId?: string;
  deadlineAt: string;
  overdueMs?: number;
  warned?: boolean;
  escalated?: boolean;
  legalBasis: string;
}

export interface BatchReviewResult { generatedAt: string; total: number; overdue: number; nearing: number; items: BatchReviewItem[]; reviewEventId?: string; }

const recordKey = (record: DeadlineRecord): string | undefined => record.subjectId;

/**
 * 监管时限与合规留痕应用服务。
 * 所有写操作都转换为案件事件流上的事件，投影结果与 ReplayService 完全一致；
 * 临近/逾期/升级通知先落事件再出通知，保证重放时通知可复现。
 */
export class ComplianceService {
  constructor(
    private readonly events: EventStore,
    private readonly claims: ClaimService,
    private readonly projector: ComplianceProjector,
    private readonly notifications: NotificationLog,
  ) {}

  projection(claimId: string, nowIso?: string): ComplianceProjection {
    this.claims.get(claimId);
    return this.projector.project(this.events.list(claimId), nowIso ?? iso());
  }

  report(claimId: string, nowIso?: string): ComplianceReport {
    const at = iso(nowIso);
    this.claims.get(claimId);
    const eventList = this.events.list(claimId);
    const projection = this.projector.project(eventList, at);
    return {
      claimId, region: projection.region, line: projection.line, channel: projection.channel,
      ruleVersion: projection.snapshot?.version, frozenAt: projection.snapshot?.frozenAt, generatedAt: at,
      records: projection.records, timeline: this.timeline(claimId, at), notifications: this.notifications.list({ claimId }),
    };
  }

  timeline(claimId: string, nowIso?: string): TimelineEntry[] {
    const at = iso(nowIso);
    const eventList = this.events.list(claimId);
    const projection = this.projector.project(eventList, at);
    const entries: TimelineEntry[] = eventList.map((event) => ({
      at: event.occurredAt, eventId: event.id, sequence: event.sequence, source: 'claim_event' as const,
      type: event.type, actor: event.actor, summary: this.summarize(event),
    }));
    for (const record of projection.records) {
      entries.push({ at: record.anchorAt, source: 'deadline', type: 'deadline.anchored', deadlineKind: record.kind, summary: `${record.kind} clock anchored (${record.basis.legalBasis})` });
      for (const suspension of record.suspensions) {
        entries.push({ at: suspension.from, eventId: suspension.eventId, source: 'deadline', type: 'deadline.paused', deadlineKind: record.kind, summary: `clock paused: ${suspension.reason}` });
        if (suspension.to) entries.push({ at: suspension.to, eventId: suspension.resumeEventId, source: 'deadline', type: 'deadline.resumed', deadlineKind: record.kind, summary: `clock resumed after ${suspension.durationMs} ms tolled` });
      }
      for (const delay of record.delayReasons) entries.push({ at: delay.at, eventId: delay.eventId, source: 'deadline', type: 'deadline.delay', deadlineKind: record.kind, summary: `delay [${delay.category}]: ${delay.reason}` });
      for (const revision of record.revisions) entries.push({ at: revision.at, eventId: revision.eventId, source: 'deadline', type: 'deadline.revised', deadlineKind: record.kind, summary: `${revision.reason}: ${revision.priorDeadline ?? '(new)'} -> ${revision.newDeadline}${revision.resetSuspensions ? ' (suspensions reset)' : ''}` });
      entries.push({ at: record.deadlineAt, source: 'deadline', type: 'deadline.due', deadlineKind: record.kind, summary: `regulatory deadline: ${record.status}${record.fulfilledAt ? `, fulfilled ${record.fulfilledAt}` : ''}` });
      if (record.fulfilledAt) entries.push({ at: record.fulfilledAt, eventId: record.fulfilledByEventId, source: 'deadline', type: 'deadline.fulfilled', deadlineKind: record.kind, summary: `outcome ${record.outcome} via ${record.fulfilledByEvent}${record.overdueMs ? `, overdue by ${record.overdueMs} ms` : ''}` });
    }
    // 同一时刻：真实案件事件（带 sequence）在前，派生的时限锚点等条目在后
    return entries.sort((a, b) => a.at.localeCompare(b.at) || ((a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER)));
  }

  pauseClock(claimId: string, input: { kind: DeadlineKind; key?: string; reason: string }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    this.claims.get(claimId);
    const at = iso(occurredAt);
    this.events.append(claimId, 'deadline.clock.paused', { kind: input.kind, key: input.key, reason: input.reason }, actor, idemKey ?? `pause:${input.kind}:${input.key ?? ''}:${at}`, at);
    return this.report(claimId, at);
  }

  resumeClock(claimId: string, input: { kind: DeadlineKind; key?: string }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    this.claims.get(claimId);
    const at = iso(occurredAt);
    this.events.append(claimId, 'deadline.clock.resumed', { kind: input.kind, key: input.key }, actor, idemKey ?? `resume:${input.kind}:${input.key ?? ''}:${at}`, at);
    return this.report(claimId, at);
  }

  restartClock(claimId: string, input: { kind: DeadlineKind; key?: string; reason: string }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    this.claims.get(claimId);
    const at = iso(occurredAt);
    this.events.append(claimId, 'deadline.clock.restarted', { kind: input.kind, key: input.key, reason: input.reason }, actor, idemKey ?? `restart:${input.kind}:${input.key ?? ''}:${at}`, at);
    return this.report(claimId, at);
  }

  recordDelay(claimId: string, input: { kind: DeadlineKind; key?: string; reason: string; category?: 'insurer' | 'external' | 'claimant' | 'regulator'; extendDays?: number }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    this.claims.get(claimId);
    const at = iso(occurredAt);
    this.events.append(claimId, 'deadline.delay.recorded', input, actor, idemKey ?? `delay:${input.kind}:${input.key ?? ''}:${at}`, at);
    return this.report(claimId, at);
  }

  reopen(claimId: string, input: { reason: string }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    const at = iso(occurredAt);
    this.claims.addEvent(claimId, 'claim.reopened', { reason: input.reason }, actor, idemKey ?? `reopen:${claimId}:${at}`, at);
    return this.report(claimId, at);
  }

  registerComplaint(claimId: string, input: { complaintId?: string; source?: string; summary?: string; registeredAt?: string }, actor: string, idemKey?: string): ComplianceReport {
    const at = iso(input.registeredAt);
    const claimEvents = this.events.list(claimId);
    if (!claimEvents.length) throw new Error(`unknown claim ${claimId}`);
    const count = claimEvents.filter((e) => e.type === 'complaint.registered').length + 1;
    const complaintId = input.complaintId ?? `COMP-${claimId.slice(-6)}-${count}`;
    this.events.append(claimId, 'complaint.registered', { complaintId, source: input.source ?? 'regulator', summary: input.summary ?? '' }, actor, idemKey ?? `complaint:${complaintId}`, at);
    return this.report(claimId, at);
  }

  respondComplaint(claimId: string, input: { complaintId?: string; response: unknown; respondedAt?: string }, actor: string, idemKey?: string): ComplianceReport {
    const at = iso(input.respondedAt);
    const projection = this.projection(claimId, at);
    const target = projection.records.filter((r) => r.kind === 'complaint_response').find((r) => r.subjectId === input.complaintId) ?? projection.records.filter((r) => r.kind === 'complaint_response').at(-1);
    if (!target) throw new Error('no registered complaint for this claim');
    this.events.append(claimId, 'complaint.responded', { complaintId: target.subjectId, response: input.response }, actor, idemKey ?? `complaint-response:${target.subjectId}:${at}`, at);
    return this.report(claimId, at);
  }

  requestDocuments(claimId: string, input: { kinds: string[] }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    const at = iso(occurredAt);
    this.claims.addEvent(claimId, 'documents.requested', { kinds: input.kinds }, actor, idemKey ?? `docs:${claimId}:${at}`, at);
    return this.report(claimId, at);
  }

  receiveDocuments(claimId: string, input: { kinds: string[] }, actor: string, occurredAt?: string, idemKey?: string): ComplianceReport {
    const at = iso(occurredAt);
    this.claims.addEvent(claimId, 'documents.received', { kinds: input.kinds }, actor, idemKey ?? `docs-recv:${claimId}:${at}`, at);
    return this.report(claimId, at);
  }

  /** 定时扫描：对全部案件检测截止时间临近（按规则中的 warningsAtHours）与逾期（超 escalateAfterHours 升级） */
  scan(nowIso?: string, claimIds?: string[]): { scanned: number; warnings: Notification[]; escalations: Notification[] } {
    const at = iso(nowIso);
    const ids = claimIds ?? this.events.aggregates();
    const warnings: Notification[] = [];
    const escalations: Notification[] = [];
    for (const claimId of ids) {
      if (!this.events.list(claimId).length) continue;
      const projection = this.projector.project(this.events.list(claimId), at);
      for (const record of projection.records) {
        if (record.status === 'met' || record.openPause) continue; // 已履行或时钟暂停中（尚未恢复）的不发通知
        const deadlineMs = new Date(record.deadlineAt).getTime();
        const nowMs = new Date(at).getTime();
        const hoursLeft = (deadlineMs - nowMs) / 3_600_000;
        // 临近通知：取已被跨过的最大预警档位
        const level = record.basis.warningsAtHours.filter((h) => hoursLeft <= h).sort((a, b) => b - a)[0];
        if (level !== undefined && !record.warned) {
          this.events.append(claimId, 'deadline.warning.raised', { kind: record.kind, key: recordKey(record), level, hoursLeft: Math.round(hoursLeft * 100) / 100 }, 'system', `warning:${record.kind}:${record.subjectId ?? 'claim'}:${level}`, at);
          warnings.push(this.notifications.emit({ kind: 'deadline_warning', claimId, deadlineKind: record.kind, subjectId: record.subjectId, level, message: `${record.kind} deadline in <= ${level}h`, deadlineAt: record.deadlineAt }));
        }
        const overdueMs = nowMs - deadlineMs;
        if (overdueMs > 0) {
          if (!record.escalated && overdueMs / 3_600_000 >= record.basis.escalateAfterHours) {
            this.events.append(claimId, 'deadline.escalated', { kind: record.kind, key: recordKey(record), overdueMs, level: 1 }, 'system', `escalation:${record.kind}:${record.subjectId ?? 'claim'}:1`, at);
            escalations.push(this.notifications.emit({ kind: 'deadline_escalation', claimId, deadlineKind: record.kind, subjectId: record.subjectId, level: 1, message: `${record.kind} overdue beyond ${record.basis.escalateAfterHours}h, escalated`, deadlineAt: record.deadlineAt }));
          } else if (!record.escalated) {
            warnings.push(this.notifications.emit({ kind: 'deadline_overdue', claimId, deadlineKind: record.kind, subjectId: record.subjectId, level: 0, message: `${record.kind} overdue`, deadlineAt: record.deadlineAt }));
          }
        }
      }
    }
    return { scanned: ids.length, warnings, escalations };
  }

  /** 批量复核：列出逾期/临近案件，留痕一次复核事件，并批量确认通知 */
  batchReview(input: { onlyOverdue?: boolean; region?: string; kind?: DeadlineKind; reviewer?: string; note?: string; acknowledge?: boolean; now?: string } = {}): BatchReviewResult {
    const at = iso(input.now);
    const items: BatchReviewItem[] = [];
    for (const claimId of this.events.aggregates()) {
      if (!this.events.list(claimId).length) continue;
      const projection = this.projector.project(this.events.list(claimId), at);
      if (input.region && projection.region !== input.region) continue;
      for (const record of projection.records) {
        if (input.kind && record.kind !== input.kind) continue;
        if (record.openPause) continue; // 时钟暂停中的截止时间不纳入逾期/临近复核
        const overdue = record.status === 'overdue';
        const hoursLeft = (new Date(record.deadlineAt).getTime() - new Date(at).getTime()) / 3_600_000;
        const nearing = !overdue && record.basis.warningsAtHours.some((h) => hoursLeft <= h);
        if (!overdue && !nearing) continue;
        if (input.onlyOverdue && !overdue) continue;
        items.push({ claimId, region: projection.region, line: projection.line, status: record.status, kind: record.kind, subjectId: record.subjectId, deadlineAt: record.deadlineAt, overdueMs: record.overdueMs, warned: record.warned, escalated: record.escalated, legalBasis: record.basis.legalBasis });
      }
    }
    const byClaim = new Set(items.map((i) => i.claimId));
    let reviewEventId: string | undefined;
    for (const claimId of byClaim) {
      const event = this.events.append(claimId, 'compliance.reviewed', { reviewer: input.reviewer ?? 'compliance-officer', note: input.note ?? 'batch review', itemCount: items.filter((i) => i.claimId === claimId).length }, input.reviewer ?? 'compliance-officer', `batch-review:${claimId}:${at}`, at);
      reviewEventId = event.id;
      this.notifications.emit({ kind: 'batch_review', claimId, deadlineKind: 'all', level: 0, message: `batch compliance review completed (${items.filter((i) => i.claimId === claimId).length} item(s))`, deadlineAt: at });
      if (input.acknowledge !== false) this.notifications.acknowledge((n) => n.claimId === claimId);
    }
    items.sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt));
    return { generatedAt: at, total: items.length, overdue: items.filter((i) => i.status === 'overdue').length, nearing: items.filter((i) => i.status === 'pending').length, items, reviewEventId };
  }

  private summarize(event: DomainEvent): string {
    const payload = event.payload as any;
    switch (event.type) {
      case 'deadline.clock.paused': return `clock paused (${payload.kind}): ${payload.reason}`;
      case 'deadline.clock.resumed': return `clock resumed (${payload.kind})`;
      case 'deadline.clock.restarted': return `clock restarted (${payload.kind}): ${payload.reason}`;
      case 'deadline.delay.recorded': return `delay recorded (${payload.kind}, ${payload.category}): ${payload.reason}${payload.extendDays ? ` +${payload.extendDays}d` : ''}`;
      case 'deadline.warning.raised': return `warning level ${payload.level} (${payload.kind})`;
      case 'deadline.escalated': return `overdue escalation (${payload.kind})`;
      case 'complaint.registered': return `complaint ${payload.complaintId} registered via ${payload.source}`;
      case 'complaint.responded': return `complaint ${payload.complaintId} responded`;
      case 'compliance.reviewed': return `compliance review: ${payload.note}`;
      default: return event.type;
    }
  }
}
