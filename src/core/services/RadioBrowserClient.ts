// PROSM Time - a scoped TS port of PROSM Platform's own
// RadioBrowserProvider (§ final visual consistency pass, correction 6:
// "Implement the Header Radio using the existing/proven PROSM Platform
// Center radio capability/pattern... do not invent a separate radio
// architecture"). Radio Browser (https://api.radio-browser.info/) is a
// genuinely public, keyless station directory API designed for direct
// client consumption - calling it straight from the browser is the
// correct architecture here, exactly as Platform's own provider does.
//
// Deliberately scoped down from Platform's full provider: only
// search + a default "top stations" browse list are ported (what a
// Header radio widget actually needs). listCountries/listLanguages/
// listTags/topVoted/recentlyAdded/getNowPlaying and the Favorites/
// History repositories are Platform's own fuller Radio Center surface
// and/or Supabase-backed - prosm-time runs against its own separate
// Supabase project, so nothing backend-coupled is ported (see the
// project's own documented Radio decision). Playback still works fully;
// only "save a favorite" / "recent history" are absent.
const MIRROR_DISCOVERY_URL = "https://all.api.radio-browser.info/json/servers";
const FALLBACK_MIRROR_HOSTS = ["de1.api.radio-browser.info", "de2.api.radio-browser.info"];
const REQUEST_TIMEOUT_MS = 8000;
// § user-reported real perf/quality issue (#11, 2026-09-15) - "Radio...
// very weak/poor in operation." hidebroken already filters out streams
// Radio Browser's own tracking knows are dead, but said nothing about
// STREAM QUALITY - a popular but genuinely low-bitrate station could
// still rank ahead of a real, clear one on clickcount alone. Verified
// live against the real API: bitrateMin is honored on /search but
// silently ignored on the path-based /topclick and /bycountry
// endpoints - so listTopStations/listByCountry below were switched to
// /search (order=clickcount&reverse=true, with/without a country
// filter) specifically so this floor actually applies to them too.
// 96 kbps is a real, audible quality floor without over-filtering
// thinner catalogs (a specific country's own station list) down to
// almost nothing.
const MIN_BITRATE_KBPS = 96;

export interface RadioStation {
  stationUuid: string;
  name: string;
  streamUrl: string;
  favicon: string | null;
  country: string | null;
  tags: string[];
  bitrate: number | null;
}

interface RawStationRow {
  stationuuid: string;
  name: string;
  url_resolved?: string;
  url?: string;
  favicon?: string;
  country?: string;
  tags?: string;
  bitrate?: number;
  clickcount?: number;
}

function mapStation(row: RawStationRow): RadioStation {
  return {
    stationUuid: row.stationuuid,
    name: row.name,
    streamUrl: row.url_resolved || row.url || "",
    favicon: row.favicon || null,
    country: row.country || null,
    tags: row.tags ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    bitrate: typeof row.bitrate === "number" ? row.bitrate : null,
  };
}

class RadioBrowserClient {
  private mirrorHosts: string[] = [...FALLBACK_MIRROR_HOSTS];
  private mirrorsDiscovered = false;

  // § user-reported real perf issue (#11, 2026-09-15) - "Radio...
  // very slow to load." Root cause: every real request awaited this
  // full mirror-discovery round trip FIRST, even though
  // FALLBACK_MIRROR_HOSTS are already real, working official Radio
  // Browser mirrors - the very first station list/search always paid
  // for two sequential network round trips (discovery, then the real
  // request) instead of one. Fire-and-forget now: the real request
  // proceeds immediately against the seed fallback hosts, discovery
  // still runs and updates this.mirrorHosts in the background for
  // whichever request comes next - no request is ever blocked on it.
  private ensureMirrors(): void {
    if (this.mirrorsDiscovered) return;
    this.mirrorsDiscovered = true;
    fetch(MIRROR_DISCOVERY_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then((response) => (response.ok ? (response.json() as Promise<Array<{ name?: string }>>) : null))
      .then((servers) => {
        const hosts = (servers ?? []).map((server) => server.name).filter((name): name is string => Boolean(name));
        if (hosts.length > 0) this.mirrorHosts = hosts;
      })
      .catch(() => {
        // Discovery failing is not fatal - the seed FALLBACK_MIRROR_HOSTS list keeps working.
      });
  }

  private async requestJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    this.ensureMirrors();

    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined) as [string, string][]).toString();
    const hosts = this.mirrorHosts.length > 0 ? this.mirrorHosts : FALLBACK_MIRROR_HOSTS;

    let lastError: unknown = null;
    for (const host of hosts) {
      try {
        const url = `https://${host}${path}${query ? `?${query}` : ""}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`Radio Browser mirror ${host} responded ${response.status}`);
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("No Radio Browser mirror was reachable.");
  }

  // Free-text search fanned out across name/tag/language (VERIFIED
  // behavior, same rationale as Platform's own provider: Radio
  // Browser's `name` filter is a literal substring match against a
  // station's display name only, so a query like a country or genre
  // word needs the tag/language fan-out to surface real coverage).
  async search(query: string, limit = 40): Promise<RadioStation[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const lowered = trimmed.toLowerCase();
    const baseParams = { limit, hidebroken: "true", order: "clickcount", reverse: "true", bitrateMin: MIN_BITRATE_KBPS };

    const settled = await Promise.allSettled([
      this.requestJson<RawStationRow[]>("/json/stations/search", { ...baseParams, name: trimmed }),
      this.requestJson<RawStationRow[]>("/json/stations/search", { ...baseParams, tag: lowered }),
      this.requestJson<RawStationRow[]>("/json/stations/search", { ...baseParams, language: lowered }),
    ]);

    const merged = new Map<string, RawStationRow>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const row of result.value ?? []) {
        if (!merged.has(row.stationuuid)) merged.set(row.stationuuid, row);
      }
    }

    return [...merged.values()]
      .sort((a, b) => (b.clickcount ?? 0) - (a.clickcount ?? 0))
      .slice(0, limit)
      .map(mapStation);
  }

  async listTopStations(limit = 30): Promise<RadioStation[]> {
    // § switched from the path-based /topclick/{limit} to /search -
    // see this file's own MIN_BITRATE_KBPS comment for why: bitrateMin
    // is silently ignored on the path-based endpoint, verified live.
    const rows = await this.requestJson<RawStationRow[]>("/json/stations/search", {
      limit,
      hidebroken: "true",
      order: "clickcount",
      reverse: "true",
      bitrateMin: MIN_BITRATE_KBPS,
    });
    return (rows ?? []).map(mapStation);
  }

  // § live UX review, user-directed - "widen the radio's range, add
  // Egyptian/Arab stations." Same /search switch as listTopStations
  // above (country= replicates the old path-based /bycountry endpoint,
  // but actually honors bitrateMin - verified live, the path-based
  // version silently ignored it).
  async listByCountry(country: string, limit = 20): Promise<RadioStation[]> {
    const rows = await this.requestJson<RawStationRow[]>("/json/stations/search", {
      country,
      limit,
      hidebroken: "true",
      order: "clickcount",
      reverse: "true",
      bitrateMin: MIN_BITRATE_KBPS,
    });
    return (rows ?? []).map(mapStation);
  }
}

export default new RadioBrowserClient();
