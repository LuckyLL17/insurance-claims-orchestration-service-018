// 监管时限规则：按版本发布与冻结，按 地区 + 险种 + 报案渠道 解析出各法定时限规格。
// 案件创建时通过 policy.snapshot.created 事件里的 ruleSnapshot.version 冻结版本，重放时永远使用冻结版本。

export type DeadlineKind = 'material_notice' | 'first_decision' | 'payment' | 'complaint_response';

export interface DeadlineSpec {
  ruleId: string;
  kind: DeadlineKind;
  days: number;
  dayType: 'business' | 'calendar';
  pausable: boolean;          // 材料补交、监管核准等暂停区间是否停止计时
  warnBeforeDays: number;     // 截止前多少天触发临近通知
  resetsOnReopen: boolean;    // 案件重开后是否重新起算
}

export interface DeadlineProfile {
  region: string;             // 'CN'、'CN-HK' 或 '*'
  lineOfBusiness: string;     // 'auto'、'property' 或 '*'
  channel?: string;           // 渠道精确匹配优先于缺省
  specs: DeadlineSpec[];
}

const CN_AUTO: DeadlineSpec[] = [
  { ruleId: 'CN-AUTO-MATERIAL-NOTICE', kind: 'material_notice', days: 3, dayType: 'business', pausable: false, warnBeforeDays: 1, resetsOnReopen: false },
  { ruleId: 'CN-AUTO-FIRST-DECISION', kind: 'first_decision', days: 30, dayType: 'calendar', pausable: true, warnBeforeDays: 3, resetsOnReopen: true },
  { ruleId: 'CN-AUTO-PAYMENT', kind: 'payment', days: 10, dayType: 'calendar', pausable: false, warnBeforeDays: 2, resetsOnReopen: true },
  { ruleId: 'CN-AUTO-COMPLAINT', kind: 'complaint_response', days: 15, dayType: 'calendar', pausable: false, warnBeforeDays: 2, resetsOnReopen: false },
];

export class DeadlineRuleBook {
  private readonly versions = new Map<string, DeadlineProfile[]>();
  private activeVersion = '2026.10';

  constructor() {
    this.versions.set('2026.10', [
      { region: 'CN', lineOfBusiness: 'auto', specs: CN_AUTO },
      {
        region: 'CN', lineOfBusiness: 'auto', channel: 'mobile',
        specs: CN_AUTO.map((spec) => spec.kind === 'material_notice' ? { ...spec, ruleId: 'CN-AUTO-MOBILE-MATERIAL-NOTICE', days: 1 } : spec),
      },
      {
        region: 'CN-HK', lineOfBusiness: 'auto',
        specs: CN_AUTO.map((spec) => ({ ...spec, ruleId: spec.ruleId.replace('CN-', 'CN-HK-'), days: spec.kind === 'first_decision' ? 21 : spec.days })),
      },
      { region: '*', lineOfBusiness: '*', specs: CN_AUTO.map((spec) => ({ ...spec, ruleId: spec.ruleId.replace('CN-AUTO', 'DEFAULT') })) },
    ]);
  }

  publish(version: string, profiles: DeadlineProfile[]): void {
    if (!/^\d{4}\.\d+$/.test(version)) throw new Error('rule version must look like YYYY.N');
    if (this.versions.has(version)) throw new Error(`deadline rule version already exists: ${version}`);
    this.versions.set(version, profiles);
    this.activeVersion = version;
  }

  active(): string { return this.activeVersion; }

  resolve(version: string, region: string, lineOfBusiness: string, channel: string): DeadlineSpec[] {
    const profiles = this.versions.get(version) ?? this.versions.get(this.activeVersion);
    if (!profiles) throw new Error(`unknown deadline rule version ${version}`);
    const candidates = profiles.filter((p) => (p.region === region || p.region === '*') && (p.lineOfBusiness === lineOfBusiness || p.lineOfBusiness === '*'));
    const profile = candidates.find((p) => p.channel === channel) ?? candidates.find((p) => !p.channel);
    if (!profile) throw new Error(`no deadline profile for ${region}/${lineOfBusiness}/${channel} in ${version}`);
    return profile.specs;
  }
}
