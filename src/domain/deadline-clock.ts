import { DeadlineDayKind } from './types';
import { HolidayCalendar } from './calendar';
import { iso } from './ids';

export interface PauseInterval { from: string; to?: string; reason?: string }
export interface ClockStep { date: string; working: boolean; windowMs: number; pausedMs: number; countedMs: number; countedDays: number; kind: DeadlineDayKind; }
export interface ClockResult { deadlineAt: string; creditedMs: number; targetMs: number; steps: ClockStep[]; }

const MS_PER_DAY = 24 * 60 * 60 * 1000;
interface Piece { from: number; to: number }

/** 计算一组暂停区间在 [from,to] 内覆盖的毫秒数；开放区间（无 to）按 now 截断，用于滚动预测 */
export function clippedPauseMs(pauses: PauseInterval[], from: number, to: number, nowMs: number): number {
  let paused = 0;
  for (const interval of pauses) {
    const start = Math.max(new Date(iso(interval.from)).getTime(), from);
    const endAt = interval.to ? new Date(iso(interval.to)).getTime() : nowMs;
    const end = Math.min(endAt, to);
    if (end > start) paused += end - start;
  }
  return paused;
}

function subtractPauses(window: Piece, pauses: PauseInterval[], nowMs: number): Piece[] {
  const cuts = new Set<number>([window.from, window.to]);
  for (const interval of pauses) {
    const start = Math.max(new Date(iso(interval.from)).getTime(), window.from);
    const endAt = interval.to ? new Date(iso(interval.to)).getTime() : nowMs;
    const end = Math.min(endAt, window.to);
    if (end > start) { cuts.add(start); cuts.add(end); }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const mid = (points[i] + points[i + 1]) / 2;
    const insidePause = pauses.some((p) => {
      const s = new Date(iso(p.from)).getTime();
      const e = p.to ? new Date(iso(p.to)).getTime() : nowMs;
      return mid >= s && mid < e;
    });
    if (!insidePause) pieces.push({ from: points[i], to: points[i + 1] });
  }
  return pieces;
}

/**
 * 法定时限时钟（纯函数式计算，结果可完全复现）。
 *
 * 起算规则：起算点当日不计时，自次一当地日起算（期间起算惯例）。
 * - calendar：按当地日整日计数 N 日（夏令时跳转日仍为 1 日）；整日被暂停覆盖的日子不计，
 *   部分暂停的日子按可计时比例累计，因此暂停多久就顺延多久。
 * - working：仅监管工作日（法定节假日/周末不计，调休上班日计）的当地办事窗口计时；
 *   一个完整办事窗口计为 1 日，被暂停切碎（窗口不完整）的工作日不计，顺延至下一工作日。
 * 截止点：noticeHours=24:00 为第 N 个计时日当地结束（次日 00:00）；指定 HH:MM 为该日当地钟点。
 */
export class DeadlineClock {
  constructor(private readonly calendar: HolidayCalendar) {}

  advance(startAtIso: string, dayKind: DeadlineDayKind, durationDays: number, noticeHours: string, region: string, pauses: PauseInterval[] = [], nowIso?: string): ClockResult {
    const startMs = new Date(iso(startAtIso)).getTime();
    const nowMs = new Date(iso(nowIso)).getTime();
    const cal = this.calendar.get(region);
    const workWindowMs = (cal.businessHours.end - cal.businessHours.start) * 3_600_000;
    const targetDays = durationDays;

    const steps: ClockStep[] = [];
    let creditedDays = 0;
    let date = this.calendar.localDate(new Date(startMs).toISOString(), region);
    let deadlineDate = date;
    let guard = 0;

    for (;;) {
      date = this.calendar.nextDate(date);
      guard += 1;
      if (guard > 5000) throw new Error('deadline clock failed to converge (paused forever?)');

      if (dayKind === 'working' && !this.calendar.isWorkingDay(date, region)) {
        steps.push({ date, working: false, windowMs: 0, pausedMs: 0, countedMs: 0, countedDays: 0, kind: 'working' });
        continue;
      }

      const window: Piece = dayKind === 'calendar'
        ? { from: this.calendar.localToUtc(date, 0, 0, region), to: this.calendar.localToUtc(this.calendar.nextDate(date), 0, 0, region) }
        : {
            from: this.calendar.businessStartUtc(date, region),
            to: cal.businessHours.end === 24
              ? this.calendar.localToUtc(this.calendar.nextDate(date), 0, 0, region)
              : this.calendar.localToUtc(date, cal.businessHours.end, 0, region),
          };
      const windowMs = window.to - window.from;
      const pausedMs = clippedPauseMs(pauses, window.from, window.to, nowMs);
      const pieces = subtractPauses(window, pauses, nowMs);
      const countedMs = pieces.reduce((sum, piece) => sum + (piece.to - piece.from), 0);
      // 该日可计的“日数”：自然日按可计时占比（DST 日无暂停时窗口本身即 1 日）；工作日要求窗口完整才计 1 日
      const countedDayPortion = dayKind === 'working'
        ? (countedMs >= workWindowMs ? 1 : 0)
        : (windowMs > 0 ? countedMs / windowMs : 0);
      steps.push({ date, working: true, windowMs, pausedMs, countedMs, countedDays: countedDayPortion, kind: dayKind });

      if (creditedDays + countedDayPortion >= targetDays) {
        deadlineDate = date;
        creditedDays = targetDays;
        break;
      }
      creditedDays += countedDayPortion;
    }

    const targetMs = targetDays * MS_PER_DAY;
    if (noticeHours === '24:00') {
      const deadlineAt = this.calendar.localToUtc(this.calendar.nextDate(deadlineDate), 0, 0, region);
      return { deadlineAt: new Date(deadlineAt).toISOString(), creditedMs: creditedDays * MS_PER_DAY, targetMs, steps };
    }
    const [h, m] = noticeHours.split(':').map(Number);
    const deadlineAt = this.calendar.localToUtc(deadlineDate, h, m, region);
    return { deadlineAt: new Date(deadlineAt).toISOString(), creditedMs: creditedDays * MS_PER_DAY, targetMs, steps };
  }
}
