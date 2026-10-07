import { EventStore } from './event-store';
import { ClaimService } from './claim-service';
import { ClockCalendar, defaultCalendar } from '../domain/compliance-clock';
import { DeadlineRecord, computeDeadlines } from '../domain/deadline';
import { DeadlineKind, DeadlineRuleBook } from '../domain/deadline-rules';

export interface TimelineEntry { at: string; kind: 'event' | 'deadline'; label: string; detail: string; }
export interface ScanResult { claimId: string; notifications: DeadlineRecord[]; escalations: { deadlineId: string; level: string; assignee: string }[]; }

const ESCALATION_LADDER: { minOverdueDays: number; level: string; assignee: string }[] = [
  { minOverdueDays: 10, level: 'L3', assignee: 'regulator-liaison' },
  { minOverdueDays: 3, level: 'L2', assignee: 'compliance-officer' },
  { minOverdueDays: 0, level: 'L1', assignee: 'claims-lead' },
];

export class ComplianceService {
  constructor(
    private readonly events: EventStore,
    private readonly claims: ClaimService,
    readonly book = new DeadlineRuleBook(),
    readonly calendar: ClockCalendar = defaultCalendar(),
  ) {}

  deadlines(claimId: string, now = new Date()): DeadlineRecord[] {
    return computeDeadlines(this.events.list(claimId), { claimId, now, book: this.book, calendar: this.calendar });
  }

  // 案件级合规时间线：案件审计事件 + 每条时限的起算/暂停/截止/完成/通知/升级/复核节点。
  timeline(claimId: string, now = new Date()): { claimId: string; deadlines: DeadlineRecord[]; entries: TimelineEntry[] } {
    const state = this.claims.get(claimId);
    const deadlines = this.deadlines(claimId, now);
    const entries: TimelineEntry[] = state.audit.map((entry) => ({ at: entry.occurredAt, kind: 'event', label: entry.type, detail: entry.summary }));
    for (const deadline of deadlines) {
      entries.push({ at: deadline.anchor.occurredAt, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.started`, detail: deadline.basis });
      for (const pause of deadline.pauses) {
        entries.push({ at: pause.start, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.paused`, detail: pause.reason });
        if (pause.end) entries.push({ at: pause.end, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.resumed`, detail: pause.reason });
      }
      entries.push({ at: deadline.dueAt, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.due`, detail: `status=${deadline.status}` });
      if (deadline.fulfilledBy) entries.push({ at: deadline.fulfilledBy.occurredAt, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.fulfilled`, detail: deadline.fulfilledBy.type });
      for (const notice of deadline.notifications) entries.push({ at: notice.at, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.notified`, detail: `due ${deadline.dueLocalDate}` });
      for (const escalation of deadline.escalations) entries.push({ at: escalation.at, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.escalated`, detail: `${escalation.level} → ${escalation.assignee}` });
      if (deadline.review) entries.push({ at: deadline.review.at, kind: 'deadline', label: `${deadline.kind}#${deadline.cycle}.reviewed`, detail: `${deadline.review.outcome}: ${deadline.review.reason}` });
    }
    entries.sort((a, b) => a.at.localeCompare(b.at));
    return { claimId, deadlines, entries };
  }

  // 临近通知与逾期升级：幂等追加事件，重复扫描不会产生重复通知。
  scan(claimId: string, now = new Date()): ScanResult {
    const result: ScanResult = { claimId, notifications: [], escalations: [] };
    for (const deadline of this.deadlines(claimId, now)) {
      const open = deadline.status === 'on_track' || deadline.status === 'due_soon';
      const warnAt = new Date(deadline.dueAt).getTime() - deadline.rule.warnBeforeDays * 86_400_000;
      if (open && !deadline.notifications.length && now.getTime() >= warnAt) {
        this.events.append(claimId, 'deadline.notification', { deadlineId: deadline.id, kind: deadline.kind, dueAt: deadline.dueAt, warnBeforeDays: deadline.rule.warnBeforeDays }, 'compliance', `ntf:${deadline.id}`);
        result.notifications.push(deadline);
      }
      if (deadline.status === 'breached') {
        const overdueDays = Math.floor((now.getTime() - new Date(deadline.dueAt).getTime()) / 86_400_000);
        const step = ESCALATION_LADDER.find((item) => overdueDays >= item.minOverdueDays)!;
        if (!deadline.escalations.some((escalation) => escalation.level === step.level)) {
          this.events.append(claimId, 'deadline.escalated', { deadlineId: deadline.id, kind: deadline.kind, level: step.level, assignee: step.assignee, overdueDays }, 'compliance', `esc:${deadline.id}:${step.level}`);
          result.escalations.push({ deadlineId: deadline.id, level: step.level, assignee: step.assignee });
        }
      }
    }
    return result;
  }

  scanAll(now = new Date()): ScanResult[] { return this.events.aggregateIds().map((id) => this.scan(id, now)); }

  // 批量复核：对全部（或指定）案件的逾期/迟延时限批量登记复核结论，留痕为 deadline.reviewed 事件。
  reviewBatch(input: { claimIds?: string[]; kinds?: DeadlineKind[]; outcome: 'confirmed' | 'waived'; reason: string }, actor: string, now = new Date()) {
    const ids = input.claimIds ?? this.events.aggregateIds();
    return ids.map((claimId) => {
      const targets = this.deadlines(claimId, now).filter((deadline) =>
        (deadline.status === 'breached' || deadline.status === 'met_late') && (!input.kinds || input.kinds.includes(deadline.kind)));
      for (const deadline of targets) {
        this.events.append(claimId, 'deadline.reviewed', { deadlineId: deadline.id, kind: deadline.kind, outcome: input.outcome, reason: input.reason }, actor, `rev:${deadline.id}:${input.outcome}`);
      }
      return { claimId, reviewed: targets.map((deadline) => deadline.id) };
    });
  }

  // 批量复核视图：跨案件列出逾期与临近的时限。
  board(now = new Date(), status?: string): DeadlineRecord[] {
    const all = this.events.aggregateIds().flatMap((id) => this.deadlines(id, now));
    return status ? all.filter((deadline) => deadline.status === status) : all;
  }
}
