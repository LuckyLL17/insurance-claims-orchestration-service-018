import { iso } from '../domain/ids';

export type NotificationKind = 'deadline_warning' | 'deadline_overdue' | 'deadline_escalation' | 'batch_review';
export interface Notification {
  id: string;
  kind: NotificationKind;
  claimId: string;
  deadlineKind: string;
  subjectId?: string;
  level: number;
  message: string;
  deadlineAt: string;
  raisedAt: string;
  acknowledged: boolean;
}

/** 合规事件通知留痕：所有临近/逾期/升级通知均落账，可被审计与重放核对 */
export class NotificationLog {
  private items: Notification[] = [];

  emit(input: Omit<Notification, 'id' | 'raisedAt' | 'acknowledged'>): Notification {
    const notification: Notification = { ...input, id: `note_${this.items.length + 1}_${Date.now()}`, raisedAt: iso(), acknowledged: false };
    this.items.push(notification);
    return notification;
  }

  acknowledge(predicate: (n: Notification) => boolean): number {
    let count = 0;
    this.items = this.items.map((n) => (predicate(n) && !n.acknowledged ? (count += 1, { ...n, acknowledged: true }) : n));
    return count;
  }

  list(filter?: { claimId?: string; kind?: NotificationKind; acknowledged?: boolean }): Notification[] {
    return this.items.filter((n) =>
      (!filter?.claimId || n.claimId === filter.claimId) &&
      (!filter?.kind || n.kind === filter.kind) &&
      (filter?.acknowledged === undefined || n.acknowledged === filter.acknowledged));
  }
}
