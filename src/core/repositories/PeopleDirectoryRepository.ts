import DatabaseManager from "../database/DatabaseManager";

export interface DirectoryPerson {
  id: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  isOwner: boolean;
  isActive: boolean;
  roleKey: string;
  roleName: string;
  roleSort: number;
  siteIds: string[];
  siteNames: string[];
  presence: "in" | "break" | "out";
  clockInAt: string | null;
  currentSiteName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
}

interface DirectoryRow {
  id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  is_owner: boolean;
  is_active: boolean;
  role_key: string;
  role_name: string;
  role_sort: number;
  site_ids: string[] | null;
  site_names: string[] | null;
  presence: DirectoryPerson["presence"];
  clock_in_at: string | null;
  current_site_name: string | null;
  shift_start: string | null;
  shift_end: string | null;
}

const MAX_AGE_MS = 60000;
let cache: { at: number; people: DirectoryPerson[] } | null = null;
let inflight: Promise<DirectoryPerson[]> | null = null;

// v2.3.43 steps 14-15 (items 17, 18): the people the reader may see, with
// their profile photo, role, sites, live status and today's shift - one
// server read (list_prosm_time_people_directory, scoped there), kept for a
// minute so every list on a page shares it.
class PeopleDirectoryRepository {
  async list(force = false): Promise<DirectoryPerson[]> {
    if (!force && cache && Date.now() - cache.at < MAX_AGE_MS) return cache.people;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { data, error } = await DatabaseManager.getClient().rpc("list_prosm_time_people_directory");
        if (error) return cache?.people ?? [];
        const people = ((data ?? []) as DirectoryRow[]).map((row) => ({
          id: row.id,
          fullName: row.full_name,
          email: row.email,
          avatarUrl: row.avatar_url,
          isOwner: row.is_owner,
          isActive: row.is_active,
          roleKey: row.role_key,
          roleName: row.role_name,
          roleSort: Number(row.role_sort ?? 100),
          siteIds: row.site_ids ?? [],
          siteNames: row.site_names ?? [],
          presence: row.presence,
          clockInAt: row.clock_in_at,
          currentSiteName: row.current_site_name,
          shiftStart: row.shift_start ? row.shift_start.slice(0, 5) : null,
          shiftEnd: row.shift_end ? row.shift_end.slice(0, 5) : null,
        }));
        cache = { at: Date.now(), people };
        return people;
      } catch {
        return cache?.people ?? [];
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // The photo of one person, from the shared list (null: show the initial).
  async avatarOf(userId: string): Promise<string | null> {
    const people = await this.list();
    return people.find((person) => person.id === userId)?.avatarUrl ?? null;
  }

  clear() {
    cache = null;
  }
}

export default new PeopleDirectoryRepository();
