import { iso } from './ids';

export interface RegionCalendar {
  region: string;
  timezone: string;
  /** 法定节假日（当地日历日，YYYY-MM-DD），即使落在工作日也不计时 */
  holidays: Set<string>;
  /** 调休上班日（当地周末但按工作日计时） */
  makeupWorkdays: Set<string>;
  /** 监管规定的办事时间区间（当地小时，24 小时制），默认 09:00-17:00 */
  businessHours: { start: number; end: number };
  version: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const cn2026: Pick<RegionCalendar, 'holidays' | 'makeupWorkdays'> = {
  holidays: new Set([
    '2026-01-01',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  ]),
  makeupWorkdays: new Set(['2026-02-14', '2026-02-28', '2026-05-09', '2026-09-19', '2026-10-10']),
};
const hk2026: Pick<RegionCalendar, 'holidays' | 'makeupWorkdays'> = {
  holidays: new Set([
    '2026-01-01',
    '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-04-03', '2026-04-04', '2026-04-06', '2026-04-07',
    '2026-05-01', '2026-05-25',
    '2026-06-19',
    '2026-07-01',
    '2026-09-26', '2026-10-01', '2026-10-19',
  ]),
  makeupWorkdays: new Set(),
};

/**
 * 地区日历：负责工作日/法定节假日/调休判定，以及当地办事时间与 UTC 时刻的换算。
 * 不依赖任何第三方时区库，使用 Node 内置 Intl（full-icu）处理 IANA 时区与夏令时边界。
 */
export class HolidayCalendar {
  private readonly regions = new Map<string, RegionCalendar>();
  private readonly formatterCache = new Map<string, Intl.DateTimeFormat>();

  constructor() {
    this.register({ region: 'CN', timezone: 'Asia/Shanghai', ...cn2026, businessHours: { start: 9, end: 17 }, version: 'CN-2026' });
    this.register({ region: 'HK', timezone: 'Asia/Hong_Kong', ...hk2026, businessHours: { start: 9, end: 17 }, version: 'HK-2026' });
    this.register({ region: 'EU', timezone: 'Europe/Berlin', holidays: new Set(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25']), makeupWorkdays: new Set(), businessHours: { start: 9, end: 17 }, version: 'EU-2026' });
    this.register({ region: 'DEFAULT', timezone: 'UTC', holidays: new Set(), makeupWorkdays: new Set(), businessHours: { start: 0, end: 24 }, version: 'DEFAULT-1' });
  }

  register(calendar: RegionCalendar): void {
    this.regions.set(calendar.region, { ...calendar, holidays: new Set(calendar.holidays), makeupWorkdays: new Set(calendar.makeupWorkdays) });
  }

  get(region: string): RegionCalendar {
    const calendar = this.regions.get(region);
    if (!calendar) throw new Error(`unknown region calendar: ${region}`);
    return calendar;
  }

  has(region: string): boolean { return this.regions.has(region); }
  list(): string[] { return [...this.regions.keys()]; }

  /**
   * 将 UTC 时刻转换为当地墙钟分量。
   * Intl en-CA + hour12:false 在当地午夜给出 hour=24，其日期标签即为该午夜所属的当地日
   * （上海 02-15 00:00 = UTC 02-14 16:00，标签为 02-15/24），故归一化为 hour=0 并保留该日期。
   */
  zonedParts(date: Date, timezone: string): { date: string; hour: number; minute: number } {
    const formatter = this.formatterCache.get(timezone) ?? new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    this.formatterCache.set(timezone, formatter);
    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    const hour = Number(get('hour'));
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
    if (hour === 24) return { date: dateStr, hour: 0, minute: 0 };
    return { date: dateStr, hour, minute: Number(get('minute')) };
  }

  /** UTC 时刻归属的当地日历日 YYYY-MM-DD（当地午夜 00:00 即归属该日） */
  localDate(atIso: string, region: string): string { return this.zonedParts(new Date(iso(atIso)), this.get(region).timezone).date; }

  /** 当地日历日是否为监管工作日（排除周末与法定节假日，包含调休上班日） */
  isWorkingDay(date: string, region: string): boolean {
    const calendar = this.get(region);
    if (calendar.holidays.has(date)) return false;
    if (calendar.makeupWorkdays.has(date)) return true;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  }

  isWorkingInstant(atIso: string, region: string): boolean {
    const calendar = this.get(region);
    const { date, hour, minute } = this.zonedParts(new Date(iso(atIso)), calendar.timezone);
    if (!this.isWorkingDay(date, region)) return false;
    const minutes = hour * 60 + minute;
    return minutes >= calendar.businessHours.start * 60 && minutes < calendar.businessHours.end * 60;
  }

  /** 当地办事时间起点（如 09:00）对应的 UTC 时刻；自动处理夏令时 */
  businessStartUtc(date: string, region: string): number { return this.localToUtc(date, this.get(region).businessHours.start, 0, region); }

  /**
   * 当地某一日历日的小时:分钟换算为 UTC 毫秒。
   * 以该日当地 12:00 为锚迭代求出其 UTC 时刻，再平移到目标时分，
   * 全程避开本地午夜（Intl 在午夜给出 hour=24 的歧义标签），并自然处理夏令时。
   */
  /**
   * 当地某一日历日的小时:分钟换算为 UTC 毫秒（hour 取 0..23）。
   * 以该日当地 12:00 为锚迭代求出其 UTC，再平移到目标时分，自然处理夏令时与历史偏移。
   * 需要“当日 24:00”时调用方应传次日 00:00。
   */
  localToUtc(date: string, hour: number, minute: number, region: string): number {
    const calendar = this.get(region);
    const [y, m, d] = date.split('-').map(Number);
    let utc = Date.UTC(y, m - 1, d, 12, 0, 0);
    for (let i = 0; i < 4; i += 1) {
      const parts = this.zonedParts(new Date(utc), calendar.timezone);
      const offsetMin = 12 * 60 - (parts.hour * 60 + parts.minute);
      if (offsetMin === 0 && parts.date === date) break;
      utc += offsetMin * 60_000;
    }
    return utc + (hour * 60 + minute - 12 * 60) * 60_000;
  }

  nextDate(date: string): string { return new Date(new Date(`${date}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10); }
}
