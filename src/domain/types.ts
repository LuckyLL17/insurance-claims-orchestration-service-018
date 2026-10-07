export type ClaimStatus =
  | 'reported'
  | 'investigating'
  | 'awaiting_documents'
  | 'ready_for_adjustment'
  | 'partially_paid'
  | 'settled'
  | 'reopened'
  | 'rejected';

export type ClaimEventType =
  | 'claim.reported'
  | 'policy.snapshot.created'
  | 'compliance.snapshot.created'
  | 'evidence.added'
  | 'evidence.reviewed'
  | 'survey.assigned'
  | 'survey.completed'
  | 'documents.requested'
  | 'documents.received'
  | 'risk.assessed'
  | 'adjustment.approved'
  | 'payment.authorized'
  | 'payment.settled'
  | 'payment.reversed'
  | 'claim.reopened'
  | 'claim.rejected'
  | 'deadline.clock.paused'
  | 'deadline.clock.resumed'
  | 'deadline.clock.restarted'
  | 'deadline.delay.recorded'
  | 'deadline.warning.raised'
  | 'deadline.escalated'
  | 'complaint.registered'
  | 'complaint.responded'
  | 'compliance.reviewed';

export type DeadlineKind = 'document_notice' | 'first_decision' | 'payment' | 'complaint_response';
export type DeadlineDayKind = 'working' | 'calendar';
export type DeadlineOutcome = 'met' | 'overdue';

export interface Participant { kind: 'person' | 'vehicle' | 'device' | 'repair_shop' | 'account'; id: string; role?: string; }
export interface MonetaryAmount { currency: string; minor: number; }
export interface LossEstimate { currency: string; gross: number; deductible?: number; liabilityShare?: number; cap?: number; }
export interface PolicyVersion { policyId: string; version: number; effectiveFrom: string; effectiveTo?: string; coverages: string[]; deductibleMinor: number; limitMinor: number; }
export interface EvidenceRecord { id: string; kind: string; hash: string; version: number; receivedAt: string; reviewed: boolean; accepted?: boolean; source: string; supersedes?: string; }
export interface PaymentEntry { id: string; kind: 'authorization' | 'settlement' | 'reversal' | 'recovery'; amount: MonetaryAmount; sourceId: string; status: 'pending' | 'posted' | 'voided'; createdAt: string; }
export interface RuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface DeadlineRuleSnapshot { version: string; frozenAt: string; ruleIds: string[]; }
export interface SuspensionInterval { id: string; reason: string; from: string; to?: string; eventId: string; resumeEventId?: string; durationMs?: number; }
export interface DelayReasonRecord { id: string; reason: string; category: 'insurer' | 'external' | 'claimant' | 'regulator'; at: string; eventId: string; impactMs?: number; }
export interface DeadlineRevision { seq: number; reason: string; at: string; eventId: string; priorDeadline?: string; newDeadline: string; anchorAt?: string; resetSuspensions: boolean; }
export interface DeadlineBasis { ruleId: string; ruleVersion: string; legalBasis: string; calendarVersion: string; matched: { region: string; line: string; channel: string }; anchorEvent: string; anchorEventId: string; anchorAt: string; dayKind: DeadlineDayKind; durationDays: number; noticeHours: string; autoPauseOn?: string; autoResumeOn?: string; warningsAtHours: number[]; escalateAfterHours: number; }
export interface DeadlineRecord { kind: DeadlineKind; subjectId?: string; status: 'pending' | 'met' | 'overdue'; anchorAt: string; deadlineAt: string; basis: DeadlineBasis; suspensions: SuspensionInterval[]; delayReasons: DelayReasonRecord[]; revisions: DeadlineRevision[]; fulfilledAt?: string; fulfilledByEvent?: string; fulfilledByEventId?: string; outcome?: DeadlineOutcome; overdueMs?: number; warned?: boolean; escalated?: boolean; escalatedAt?: string; restartCount: number; openPause?: boolean; }
export interface RiskSignal { code: string; score: number; explanation: string; participants: string[]; }
export interface AuditEntry { sequence: number; eventId: string; type: ClaimEventType; occurredAt: string; actor: string; summary: string; }

export interface ClaimState {
  id: string;
  policyId: string;
  status: ClaimStatus;
  lossAt: string;
  reportedAt: string;
  channel: string;
  region: string;
  line: string;
  participants: Participant[];
  loss: LossEstimate;
  policy?: PolicyVersion;
  ruleSnapshot?: RuleSnapshot;
  deadlineSnapshot?: DeadlineRuleSnapshot;
  evidence: EvidenceRecord[];
  requiredEvidence: Set<string>;
  completedSurveys: string[];
  pendingDocuments: string[];
  complaints: { id: string; registeredAt: string; respondedAt?: string; source: string }[];
  complianceReviewedAt?: string;
  complianceReviewNote?: string;
  riskSignals: RiskSignal[];
  riskScore: number;
  payments: PaymentEntry[];
  approvedMinor: number;
  audit: AuditEntry[];
  processedEventIds: Set<string>;
  version: number;
}

export interface DomainEvent<T = unknown> {
  id: string;
  aggregateId: string;
  type: ClaimEventType;
  occurredAt: string;
  sequence: number;
  actor: string;
  idempotencyKey?: string;
  payload: T;
}

export interface ClaimReportedPayload {
  policyId: string; lossAt: string; reportedAt: string; channel: string;
  region?: string; line?: string;
  participants: Participant[]; loss: LossEstimate;
}
