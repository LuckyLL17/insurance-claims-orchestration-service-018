import { EventStore } from './application/event-store';
import { ClaimService } from './application/claim-service';
import { PaymentService } from './application/payment-service';
import { RiskService } from './application/risk-service';
import { TaskService } from './application/task-service';
import { ReplayService } from './application/replay-service';
import { ComplianceService } from './application/compliance-service';
import { NotificationLog } from './application/notification-log';
import { EvidenceLedger } from './domain/evidence';
import { PaymentLedger } from './domain/payment-ledger';
import { PolicyCatalog } from './domain/policy';
import { RiskGraph } from './domain/risk';
import { RuleEngine } from './domain/rules';
import { TaskBoard } from './domain/task';
import { HolidayCalendar } from './domain/calendar';
import { DeadlineClock } from './domain/deadline-clock';
import { DeadlineRuleBook } from './domain/deadline-rules';
import { ComplianceProjector } from './domain/compliance-projector';
import { startServer } from './http/server';

export function buildApp() {
  const events = new EventStore();
  const policies = new PolicyCatalog();
  const rules = new RuleEngine();
  const calendar = new HolidayCalendar();
  const deadlineRules = new DeadlineRuleBook();
  const claims = new ClaimService(events, policies, rules, new EvidenceLedger(), deadlineRules);
  const projector = new ComplianceProjector(new DeadlineClock(calendar), calendar, deadlineRules);
  const notifications = new NotificationLog();
  return {
    events,
    claims,
    payments: new PaymentService(claims, new PaymentLedger()),
    risks: new RiskService(claims, new RiskGraph()),
    tasks: new TaskService(claims, new TaskBoard()),
    replay: new ReplayService(events, claims),
    compliance: new ComplianceService(events, claims, projector, notifications),
    notifications,
    rules,
    deadlineRules,
    calendar,
  };
}

if (require.main === module) void startServer(buildApp());
