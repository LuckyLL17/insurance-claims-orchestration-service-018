// 法定时钟：把 UTC 时刻映射到案件地区本地日期，支持工作日、节假日与起止日换算。
// 所有函数都是纯函数，同样的输入（时刻 + 地区 + 日历）永远得到同样的结果，保证事件重放一致。

export interface LocalDate { y: number; m: number; d: number; }

const REGION_TIMEZONES: Record<string, string> = {
  CN: 'Asia/Shanghai',
  'CN-HK': 'Asia/Hong_Kong',
  US: 'America/New_York',
};

export function regionTimezone(region: string): string { return REGION_TIMEZONES[region] ?? 'UTC'; }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let cached = formatters.get(tz);
  if (!cached) { cached = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }); formatters.set(tz, cached); }
  return cached;
}

function parts(at: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(at)) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return out;
}

export function localDateOf(instant: string | Date, tz: string): LocalDate {
  const p = parts(new Date(instant), tz);
  return { y: p.year, m: p.month, d: p.day };
}

export function localKey(date: LocalDate): string {
  return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

export function weekdayOf(date: LocalDate): number { return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay(); }

// 某时刻下地区时区相对 UTC 的偏移（毫秒），用本地时分秒反推。
function offsetMs(at: Date, tz: string): number {
  const p = parts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (at.getTime() - at.getMilliseconds());
}

export function startOfDayUtc(date: LocalDate, tz: string): Date {
  const guess = Date.UTC(date.y, date.m - 1, date.d, 0, 0, 0, 0);
  let utc = guess - offsetMs(new Date(guess), tz);
  utc = guess - offsetMs(new Date(utc), tz); // 第二次迭代覆盖跨夏令时边界
  return new Date(utc);
}

export function endOfDayUtc(date: LocalDate, tz: string): Date { return new Date(startOfDayUtc(addDays(date, 1), tz).getTime() - 1); }

export class ClockCalendar {
  private readonly weekends = new Map<string, number[]>();
  private readonly holidays = new Map<string, Set<string>>();

  seed(region: string, holidays: string[], weekends = [0, 6]): void {
    this.weekends.set(region, weekends);
    this.holidays.set(region, new Set(holidays));
  }

  addHoliday(region: string, day: string): void {
    const set = this.holidays.get(region) ?? new Set<string>();
    set.add(day); this.holidays.set(region, set);
  }

  isBusinessDay(region: string, date: LocalDate): boolean {
    const weekend = this.weekends.get(region) ?? [0, 6];
    if (weekend.includes(weekdayOf(date))) return false;
    return !(this.holidays.get(region) ?? new Set<string>()).has(localKey(date));
  }
}

export function defaultCalendar(): ClockCalendar {
  const calendar = new ClockCalendar();
  calendar.seed('CN', [
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
    '2027-01-01',
  ]);
  calendar.seed('CN-HK', ['2026-01-01', '2026-02-17', '2026-02-18', '2026-10-01', '2026-10-19', '2027-01-01']);
  calendar.seed('US', ['2026-01-01', '2026-07-03', '2026-12-25', '2027-01-01']);
  return calendar;
}
