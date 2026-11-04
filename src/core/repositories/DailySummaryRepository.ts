import DatabaseManager from "../database/DatabaseManager";

export interface DailySummaryPerson {
  userId: string;
  name: string;
  site: string | null;
  firstIn: string;
  lastOut: string | null;
  stillIn: boolean;
  autoClosed: boolean;
  minutes: number;
  lateMinutes: number | null;
}

export interface DailySummary {
  date: string;
  worked: number;
  minutes: number;
  late: number;
  noShows: number;
  onLeave: number;
  people: DailySummaryPerson[];
  noShowList: { userId: string; name: string; site: string | null; start: string; end: string }[];
  leaveList: { userId: string; name: string; leave: string }[];
  waiting: { leave: number; exceptions: number; clockedInNow: number };
}

// Owner 2026-11-03: the morning summary opens a page of one day, any day, for the owner.
class DailySummaryRepository {
  get client() {
    return DatabaseManager.getClient();
  }

  async forDay(date: string): Promise<{ data: DailySummary | null; error: string | null }> {
    const { data, error } = await this.client.rpc("get_prosm_time_daily_summary", { p_date: date });
    if (error) return { data: null, error: error.message };
    return { data: data as DailySummary, error: null };
  }
}

export default new DailySummaryRepository();
