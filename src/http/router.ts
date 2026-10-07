import { IncomingMessage, ServerResponse } from 'node:http';
import { ClaimService } from '../application/claim-service';
import { PaymentService } from '../application/payment-service';
import { RiskService } from '../application/risk-service';
import { TaskService } from '../application/task-service';
import { ReplayService } from '../application/replay-service';
import { ComplianceService } from '../application/compliance-service';
import { NotificationLog } from '../application/notification-log';
import { DeadlineRuleBook } from '../domain/deadline-rules';
import { HolidayCalendar } from '../domain/calendar';
import { EventStore } from '../application/event-store';
import { RuleEngine } from '../domain/rules';

export interface AppContext {
  events: EventStore;
  claims: ClaimService;
  payments: PaymentService;
  risks: RiskService;
  tasks: TaskService;
  replay: ReplayService;
  compliance: ComplianceService;
  notifications: NotificationLog;
  rules: RuleEngine;
  deadlineRules: DeadlineRuleBook;
  calendar: HolidayCalendar;
}
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value, (_k, v) => v instanceof Set ? [...v] : v)); };
const body = async (req: IncomingMessage): Promise<any> => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const parts = (url: string) => url.split('?')[0].split('/').filter(Boolean);
const key = (req: IncomingMessage) => req.headers['idempotency-key'] as string | undefined;

export async function route(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
  try {
    const method = req.method ?? 'GET'; const path = parts(req.url ?? '/'); const input = method === 'POST' ? await body(req) : {};
    if (method === 'GET' && path[0] === 'health') return json(res, 200, { ok: true, service: 'insurance-claims-orchestration', now: new Date().toISOString() });
    if (method === 'POST' && path[0] === 'claims' && path.length === 1) return json(res, 201, app.claims.create({ ...input, loss: { ...input.loss, gross: Number(input.loss.gross) } }, 'api', key(req)));
    if (method === 'GET' && path[0] === 'regions') return json(res, 200, { regions: app.calendar.list() });
    if (method === 'POST' && path[0] === 'compliance' && path[1] === 'scan') return json(res, 200, app.compliance.scan(input.now, input.claimIds));
    if (method === 'POST' && path[0] === 'compliance' && path[1] === 'batch-review') return json(res, 200, app.compliance.batchReview(input));
    if (method === 'GET' && path[0] === 'notifications') return json(res, 200, app.notifications.list(input));
    if (path[0] !== 'claims' || !path[1]) return json(res, 404, { error: 'route not found' });
    const id = path[1];
    if (method === 'GET' && path.length === 2) return json(res, 200, app.claims.get(id));
    if (method === 'POST' && path[2] === 'evidence' && path[4] === 'review') return json(res, 200, app.claims.reviewEvidence(id, path[3], Boolean(input.accepted), 'api', key(req)));
    if (method === 'POST' && path[2] === 'evidence') return json(res, 201, app.claims.addEvidence(id, input, 'api', key(req)));
    if (method === 'POST' && path[2] === 'events') return json(res, 200, app.claims.addEvent(id, input.type, input.payload, input.actor ?? 'api', input.idempotencyKey ?? key(req), input.occurredAt));
    if (method === 'POST' && path[2] === 'risk') return json(res, 200, app.risks.assess(id, 'api'));
    if (method === 'GET' && path[2] === 'risk') return json(res, 200, { relatedClaims: app.risks.related(id), state: app.claims.get(id) });
    if (method === 'POST' && path[2] === 'payments') return json(res, 200, app.payments.settle(id, input, 'api'));
    if (method === 'POST' && path[2] === 'reversals') return json(res, 200, app.payments.reverse(id, input, 'api'));
    if (method === 'POST' && path[2] === 'tasks') return json(res, 201, app.tasks.create(id, input.kind));
    if (method === 'GET' && path[2] === 'tasks') return json(res, 200, app.tasks.list(id));
    if (method === 'POST' && path[2] === 'replay') return json(res, 200, app.replay.execute(id, input.until));

    // 监管时限与合规留痕
    if (method === 'GET' && path[2] === 'compliance') return json(res, 200, app.compliance.report(id, input.now));
    if (method === 'GET' && path[2] === 'deadlines') return json(res, 200, app.compliance.projection(id, input.now));
    if (method === 'GET' && path[2] === 'timeline') return json(res, 200, { claimId: id, timeline: app.compliance.timeline(id, input.now) });
    if (method === 'POST' && path[2] === 'deadlines' && path[3] === 'pause') return json(res, 200, app.compliance.pauseClock(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'deadlines' && path[3] === 'resume') return json(res, 200, app.compliance.resumeClock(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'deadlines' && path[3] === 'restart') return json(res, 200, app.compliance.restartClock(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'deadlines' && path[3] === 'delay') return json(res, 200, app.compliance.recordDelay(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'reopen') return json(res, 200, app.compliance.reopen(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'documents' && path[3] === 'request') return json(res, 200, app.compliance.requestDocuments(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'documents' && path[3] === 'receive') return json(res, 200, app.compliance.receiveDocuments(id, input, input.actor ?? 'api', input.occurredAt, key(req)));
    if (method === 'POST' && path[2] === 'complaints') return json(res, 201, app.compliance.registerComplaint(id, input, input.actor ?? 'api', key(req)));
    if (method === 'POST' && path[2] === 'complaints' && path[3] === 'respond') return json(res, 200, app.compliance.respondComplaint(id, input, input.actor ?? 'api', key(req)));
    return json(res, 404, { error: 'route not found' });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'unknown error' }); }
}
