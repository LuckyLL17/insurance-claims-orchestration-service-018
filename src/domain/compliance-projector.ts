import { DeadlineKind, DeadlineRecord, DeadlineRuleSnapshot, DomainEvent, SuspensionInterval, DeadlineBasis, DelayReasonRecord, DeadlineRevision } from './types';
import { DeadlineClock, PauseInterval } from './deadline-clock';
import { HolidayCalendar } from './calendar';
import { DeadlineRuleBook, DeadlineRuleDef } from './deadline-rules';
import { newId, iso } from './ids';

export interface ComplianceProjection {
  snapshot?: DeadlineRuleSnapshot;
  region: string;
  line: string;
  channel: string;
  records: DeadlineRecord[];
}

const keyOf = (kind: DeadlineKind, subjectId?: string): string => (subjectId ? `${kind}:${subjectId}` : kind);

/**
 * 合规时限投影器：把案件事件流确定性地折叠为各法定截止时间的当前状态。
 * 与 ClaimService.replay 消费同一条事件流，因此任何历史时点重放都会得到一致的合规视图。
 * 投影是纯计算，不产生副作用；扫描器据此判断临近/逾期后追加的事件，下一次投影自然反映。
 */
export class ComplianceProjector {
  constructor(private readonly clock: DeadlineClock, private readonly calendar: HolidayCalendar, private readonly ruleBook: DeadlineRuleBook) {}

  project(events: DomainEvent[], nowIso?: string): ComplianceProjection {
    const now = iso(nowIso);
    const byKey = new Map<string, DeadlineRecord>();
    let meta = { region: 'DEFAULT', line: 'auto', channel: '', snapshot: undefined as DeadlineRuleSnapshot | undefined };
    let complaintSeq = 0;
    let reportedEvent: DomainEvent | undefined;

    const openOf = (kind: DeadlineKind): DeadlineRecord | undefined => {
      for (const record of byKey.values()) if (record.kind === kind && record.status !== 'met') return record;
      return undefined;
    };
    const locate = (kind: DeadlineKind, subjectId?: string): DeadlineRecord | undefined => {
      if (subjectId && byKey.has(keyOf(kind, subjectId))) return byKey.get(keyOf(kind, subjectId));
      return openOf(kind) ?? [...byKey.values()].filter((r) => r.kind === kind).at(-1);
    };

    for (const event of events) {
      const payload = event.payload as any;

      if (event.type === 'claim.reported') {
        reportedEvent = event;
        meta = { region: payload.region ?? 'DEFAULT', line: payload.line ?? 'auto', channel: payload.channel ?? '', snapshot: meta.snapshot };
        continue;
      }
      if (event.type === 'compliance.snapshot.created') {
        meta.snapshot = payload.snapshot as DeadlineRuleSnapshot;
        meta.region = payload.region ?? meta.region;
        meta.line = payload.line ?? meta.line;
        // 报案后首次决定时限即起算（材料未齐期间按规则自动暂停）；材料通知时限在通知发出时回溯建账
        if (meta.snapshot && reportedEvent && !byKey.has(keyOf('first_decision'))) {
          byKey.set(keyOf('first_decision'), this.startRecord('first_decision', undefined, reportedEvent, meta));
        }
        continue;
      }

      if (event.type === 'documents.requested') {
        // 材料通知：以报案时点为起算点，在通知发出时建账并立即判定是否在法定窗口内发出
        let notice = [...byKey.values()].find((r) => r.kind === 'document_notice');
        if (!notice && reportedEvent) notice = this.startRecord('document_notice', undefined, reportedEvent, meta);
        if (notice && notice.status === 'pending') { this.finalize(notice, event, now, meta.region); byKey.set(keyOf('document_notice'), notice); }
        const decision = openOf('first_decision');
        if (decision && decision.basis.autoPauseOn === 'documents.requested') this.pause(decision, event, 'awaiting claimant documents (regulatory tolling)', false);
        continue;
      }
      if (event.type === 'documents.received') {
        const decision = openOf('first_decision');
        if (decision && decision.basis.autoResumeOn === 'documents.received') this.resume(decision, event, now, meta.region, false);
        continue;
      }
      if (event.type === 'adjustment.approved') {
        const decision = openOf('first_decision');
        if (decision) this.finalize(decision, event, now, meta.region);
        if (![...byKey.values()].some((r) => r.kind === 'payment')) byKey.set(keyOf('payment'), this.startRecord('payment', undefined, event, meta, undefined));
        continue;
      }
      if (event.type === 'payment.settled') {
        const payment = openOf('payment');
        if (payment) this.finalize(payment, event, now, meta.region);
        continue;
      }
      if (event.type === 'claim.rejected') {
        for (const kind of ['first_decision', 'payment'] as DeadlineKind[]) {
          const record = openOf(kind);
          if (record) this.finalize(record, event, now, meta.region);
        }
        continue;
      }
      if (event.type === 'complaint.registered') {
        complaintSeq += 1;
        const subjectId = String(payload.complaintId ?? payload.id ?? `C${complaintSeq}`);
        byKey.set(keyOf('complaint_response', subjectId), this.startRecord('complaint_response', subjectId, { ...event, payload: { ...payload, complaintId: subjectId } }, meta, undefined));
        continue;
      }
      if (event.type === 'complaint.responded') {
        const record = locate('complaint_response', payload.complaintId);
        if (record) this.finalize(record, event, now, meta.region);
        continue;
      }
      if (event.type === 'deadline.clock.paused') {
        const record = locate(payload.kind as DeadlineKind, payload.key);
        if (record && record.status === 'pending') this.pause(record, event, String(payload.reason ?? 'manual suspension'), true);
        continue;
      }
      if (event.type === 'deadline.clock.resumed') {
        const record = locate(payload.kind as DeadlineKind, payload.key);
        if (record && record.status === 'pending') this.resume(record, event, now, meta.region, true);
        continue;
      }
      if (event.type === 'deadline.clock.restarted') {
        const record = locate(payload.kind as DeadlineKind, payload.key);
        if (record) this.restart(record, event, meta.region, now, String(payload.reason ?? 'clock restarted'));
        continue;
      }
      if (event.type === 'deadline.delay.recorded') {
        const record = locate(payload.kind as DeadlineKind, payload.key);
        if (record) {
          record.delayReasons = [...record.delayReasons, {
            id: newId('delay'), reason: String(payload.reason ?? 'unspecified'), category: payload.category ?? 'external',
            at: event.occurredAt, eventId: event.id, impactMs: payload.extendDays ? Number(payload.extendDays) * 86_400_000 : undefined,
          }];
          if (payload.extendDays) {
            const prior = record.deadlineAt;
            record.basis = { ...record.basis, durationDays: record.basis.durationDays + Number(payload.extendDays) };
            this.recompute(record, meta.region, now);
            record.revisions = [...record.revisions, revision(event, prior, record, false, `delay: ${String(payload.reason ?? 'unspecified')}`)];
          }
        }
        continue;
      }
      if (event.type === 'deadline.warning.raised') {
        const record = locate(payload.kind as DeadlineKind, payload.key);
        if (record) record.warned = true;
        continue;
      }
      if (event.type === 'deadline.escalated') {
        const record = locate(payload.kind as DeadlineKind, payload.key);
        if (record) { record.escalated = true; record.escalatedAt = event.occurredAt; }
        continue;
      }
      if (event.type === 'claim.reopened') {
        // 案件重开：支付与首次决定时限以重开时点重新起算；历史暂停清空但修订留痕保留
        for (const kind of ['payment', 'first_decision'] as DeadlineKind[]) {
          const prior = [...byKey.values()].filter((r) => r.kind === kind).at(-1);
          if (prior) byKey.set(keyOf(kind), this.reopened(prior, event, meta));
        }
        continue;
      }
    }

    // 统一重算未结截止时间并按当前时刻判定逾期；时钟处于开放暂停中的保持 pending（法定计时已停止）
    for (const record of byKey.values()) {
      record.openPause = record.suspensions.some((s) => !s.to);
      if (record.status === 'pending' && !record.openPause) {
        this.recompute(record, meta.region, now);
        if (new Date(record.deadlineAt).getTime() < new Date(now).getTime()) {
          record.status = 'overdue';
          record.overdueMs = new Date(now).getTime() - new Date(record.deadlineAt).getTime();
        }
      }
    }

    return { snapshot: meta.snapshot, region: meta.region, line: meta.line, channel: meta.channel, records: [...byKey.values()] };
  }

  private startRecord(kind: DeadlineKind, subjectId: string | undefined, anchorEvent: DomainEvent, meta: { region: string; line: string; channel: string; snapshot?: DeadlineRuleSnapshot }, initialSuspensions?: SuspensionInterval[]): DeadlineRecord {
    if (!meta.snapshot) throw new Error(`cannot start ${kind} deadline before compliance snapshot is frozen`);
    const rule = this.ruleBook.match(kind, meta.region, meta.line, meta.channel, meta.snapshot.version);
    const record: DeadlineRecord = {
      kind, subjectId, status: 'pending', anchorAt: anchorEvent.occurredAt, deadlineAt: anchorEvent.occurredAt,
      basis: {
        ruleId: rule.id, ruleVersion: rule.version, legalBasis: rule.legalBasis, calendarVersion: this.calendar.get(meta.region).version,
        matched: { region: meta.region, line: meta.line, channel: meta.channel }, anchorEvent: anchorEvent.type, anchorEventId: anchorEvent.id, anchorAt: anchorEvent.occurredAt,
        dayKind: rule.dayKind, durationDays: rule.durationDays, noticeHours: rule.noticeHours,
        autoPauseOn: rule.autoPauseOn, autoResumeOn: rule.autoResumeOn, warningsAtHours: rule.warningsAtHours, escalateAfterHours: rule.escalateAfterHours,
      },
      suspensions: initialSuspensions ? initialSuspensions.map((s) => ({ ...s })) : [],
      delayReasons: [], revisions: [], restartCount: 0, warned: false, escalated: false,
    };
    this.recompute(record, meta.region, anchorEvent.occurredAt);
    return record;
  }

  private recompute(record: DeadlineRecord, region: string, nowIso: string): void {
    const pauses: PauseInterval[] = record.suspensions.map((s) => (s.to ? { from: s.from, to: s.to, reason: s.reason } : { from: s.from, reason: s.reason }));
    record.deadlineAt = this.clock.advance(record.anchorAt, record.basis.dayKind, record.basis.durationDays, record.basis.noticeHours, region, pauses, nowIso).deadlineAt;
    record.openPause = record.suspensions.some((s) => !s.to);
  }

  private pause(record: DeadlineRecord, event: DomainEvent, reason: string, manual: boolean): void {
    if (record.suspensions.some((s) => !s.to)) return;
    record.suspensions = [...record.suspensions, { id: newId('susp'), reason: manual ? reason : `${reason} [auto]`, from: event.occurredAt, eventId: event.id }];
  }

  private resume(record: DeadlineRecord, event: DomainEvent, nowIso: string, region: string, manual: boolean): void {
    const open = record.suspensions.find((s) => !s.to);
    if (!open) return;
    const prior = record.deadlineAt;
    record.suspensions = record.suspensions.map((s) => (s.id === open.id ? {
      ...s, to: event.occurredAt, resumeEventId: event.id, durationMs: new Date(event.occurredAt).getTime() - new Date(open.from).getTime(),
    } : s));
    this.recompute(record, region, nowIso);
    record.revisions = [...record.revisions, revision(event, prior, record, false, manual ? 'clock resumed' : 'documents complete, clock resumed')];
  }

  private restart(record: DeadlineRecord, event: DomainEvent, region: string, nowIso: string, reason: string): void {
    const prior = record.deadlineAt;
    record.anchorAt = event.occurredAt;
    record.restartCount += 1;
    record.status = 'pending';
    record.fulfilledAt = undefined; record.fulfilledByEvent = undefined; record.fulfilledByEventId = undefined;
    record.outcome = undefined; record.overdueMs = undefined; record.warned = false; record.escalated = false; record.escalatedAt = undefined;
    record.suspensions = [];
    this.recompute(record, region, nowIso);
    record.revisions = [...record.revisions, revision(event, prior, record, true, reason)];
  }

  private reopened(prior: DeadlineRecord, event: DomainEvent, meta: { region: string; line: string; channel: string; snapshot?: DeadlineRuleSnapshot }): DeadlineRecord {
    const record = this.startRecord(prior.kind, prior.subjectId, event, meta, []);
    record.delayReasons = prior.delayReasons.map((d) => ({ ...d }));
    record.restartCount = prior.restartCount + 1;
    record.revisions = [
      ...prior.revisions,
      revision(event, prior.deadlineAt, record, true, 'claim reopened; clock restarted'),
    ];
    return record;
  }

  private finalize(record: DeadlineRecord, event: DomainEvent, nowIso: string, region: string): void {
    this.recompute(record, region, nowIso);
    record.fulfilledAt = event.occurredAt;
    record.fulfilledByEvent = event.type;
    record.fulfilledByEventId = event.id;
    const onTime = new Date(event.occurredAt).getTime() <= new Date(record.deadlineAt).getTime();
    record.status = onTime ? 'met' : 'overdue';
    record.outcome = onTime ? 'met' : 'overdue';
    record.overdueMs = onTime ? 0 : new Date(event.occurredAt).getTime() - new Date(record.deadlineAt).getTime();
  }
}

function revision(event: DomainEvent, priorDeadline: string, record: DeadlineRecord, resetSuspensions: boolean, reason: string): DeadlineRevision {
  return { seq: record.revisions.length + 1, reason, at: event.occurredAt, eventId: event.id, priorDeadline, newDeadline: record.deadlineAt, anchorAt: record.anchorAt, resetSuspensions };
}
