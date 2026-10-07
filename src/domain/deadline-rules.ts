import { DeadlineDayKind, DeadlineKind, DeadlineRuleSnapshot } from './types';
import { iso } from './ids';

export interface DeadlineRuleDef {
  id: string;
  kind: DeadlineKind;
  version: string;
  region: string;   // '*' 表示适用所有地区
  line: string;     // '*' 表示适用所有险种
  channel: string;  // '*' 表示适用所有报案渠道
  dayKind: DeadlineDayKind;
  durationDays: number;
  legalBasis: string;
  /** 截止时刻为当地办事时间起点还是当天 24:00（次日 00:00），如 '09:00' / '24:00' */
  noticeHours: string;
  autoPauseOn?: string;
  autoResumeOn?: string;
  warningsAtHours: number[];
  escalateAfterHours: number;
}

export const DEADLINE_KINDS: DeadlineKind[] = ['document_notice', 'first_decision', 'payment', 'complaint_response'];

/**
 * 监管时限规则册。规则可按版本发布、冻结；案件在报案时冻结快照，
 * 之后即使发布新版本，已存在案件仍按冻结版本计算（规则版本冻结）。
 */
export class DeadlineRuleBook {
  private readonly versions = new Map<string, DeadlineRuleDef[]>();
  private activeVersion = '2026.10';

  constructor() {
    this.publish('2026.10', this.seed('2026.10'));
  }

  private seed(version: string): DeadlineRuleDef[] {
    const defs: Array<Omit<DeadlineRuleDef, 'id' | 'version'>> = [
      // 材料通知（一次性补件通知）：保险公司收到报案后须及时一次性书面通知
      { kind: 'document_notice', region: '*', line: '*', channel: '*', dayKind: 'working', durationDays: 1, noticeHours: '24:00', legalBasis: '保险法第二十二条 / 指引：及时一次性通知', warningsAtHours: [4], escalateAfterHours: 24 },
      { kind: 'document_notice', region: '*', line: '*', channel: 'agent', dayKind: 'working', durationDays: 2, noticeHours: '24:00', legalBasis: '代理渠道材料通知时效细则', warningsAtHours: [8], escalateAfterHours: 24 },
      { kind: 'document_notice', region: 'HK', line: '*', channel: '*', dayKind: 'working', durationDays: 2, noticeHours: '24:00', legalBasis: 'HK claims handling guideline', warningsAtHours: [8], escalateAfterHours: 48 },
      // 首次决定（核定时效）：材料齐全起 30 日内核定；复杂件可暂停
      { kind: 'first_decision', region: '*', line: '*', channel: '*', dayKind: 'calendar', durationDays: 30, noticeHours: '24:00', legalBasis: '保险法第二十三条：三十日内核定', autoPauseOn: 'documents.requested', autoResumeOn: 'documents.received', warningsAtHours: [72, 24], escalateAfterHours: 48 },
      { kind: 'first_decision', region: '*', line: 'commercial', channel: '*', dayKind: 'calendar', durationDays: 45, noticeHours: '24:00', legalBasis: '商业险复杂案件核定时效批复：四十五日', autoPauseOn: 'documents.requested', autoResumeOn: 'documents.received', warningsAtHours: [96, 24], escalateAfterHours: 72 },
      { kind: 'first_decision', region: 'EU', line: '*', channel: '*', dayKind: 'calendar', durationDays: 15, noticeHours: '24:00', legalBasis: 'EU insurance distribution claims handling: 15 days', autoPauseOn: 'documents.requested', autoResumeOn: 'documents.received', warningsAtHours: [48, 12], escalateAfterHours: 24 },
      // 补偿支付：达成赔偿协议后 10 日内支付
      { kind: 'payment', region: '*', line: '*', channel: '*', dayKind: 'calendar', durationDays: 10, noticeHours: '24:00', legalBasis: '保险法第二十三条：十日内支付赔款', warningsAtHours: [48, 12], escalateAfterHours: 24 },
      // 投诉响应：监管投诉受理后 15 个工作日内首次答复
      { kind: 'complaint_response', region: '*', line: '*', channel: '*', dayKind: 'working', durationDays: 15, noticeHours: '24:00', legalBasis: '保险消费投诉处理办法：十五个工作日', warningsAtHours: [48, 24], escalateAfterHours: 24 },
    ];
    return defs.map((def) => ({ ...def, id: this.ruleId(def.kind, def.region, def.line, def.channel), version }));
  }

  private ruleId(kind: DeadlineKind, region: string, line: string, channel: string): string { return `deadline.${kind}:r=${region};l=${line};c=${channel}`; }

  publish(version: string, definitions?: Array<Omit<DeadlineRuleDef, 'id' | 'version'>> | DeadlineRuleDef[]): void {
    if (!/^\d{4}\.\d+$/.test(version)) throw new Error('deadline rule version must look like YYYY.N');
    if (this.versions.has(version)) throw new Error(`deadline rule version already exists: ${version}`);
    const rules = (definitions ?? this.seed(version)).map((rule) => ({ ...rule, id: this.ruleId(rule.kind, rule.region, rule.line, rule.channel), version }));
    this.versions.set(version, rules);
    this.activeVersion = version;
  }

  get active(): string { return this.activeVersion; }
  freeze(version?: string): DeadlineRuleSnapshot {
    const v = version ?? this.activeVersion;
    const rules = this.versions.get(v);
    if (!rules) throw new Error(`unknown deadline rule version ${v}`);
    return { version: v, frozenAt: iso(), ruleIds: rules.map((r) => r.id) };
  }

  all(version: string): DeadlineRuleDef[] {
    const rules = this.versions.get(version);
    if (!rules) throw new Error(`unknown deadline rule version ${version}`);
    return rules;
  }

  /** 按地区/险种/渠道选择最具体的规则；具体度：精确匹配 > 通配，region > line > channel */
  match(kind: DeadlineKind, region: string, line: string, channel: string, version: string): DeadlineRuleDef {
    const candidates = this.all(version).filter((r) => r.kind === kind);
    const score = (r: DeadlineRuleDef): number => {
      if (r.region !== '*' && r.region !== region) return -1;
      if (r.line !== '*' && r.line !== line) return -1;
      if (r.channel !== '*' && r.channel !== channel) return -1;
      return (r.region !== '*' ? 4 : 0) + (r.line !== '*' ? 2 : 0) + (r.channel !== '*' ? 1 : 0);
    };
    let best: DeadlineRuleDef | undefined; let bestScore = -1;
    for (const rule of candidates) { const s = score(rule); if (s > bestScore) { best = rule; bestScore = s; } }
    if (!best) throw new Error(`no deadline rule for ${kind} (${region}/${line}/${channel}) in version ${version}`);
    return best;
  }
}
