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

  private async ensureMirrors(): Promise<void> {
    if (this.mirrorsDiscovered) return;
    this.mirrorsDiscovered = true;
    try {
      const response = await fetch(MIRROR_DISCOVERY_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return;
      const servers = (await response.json()) as Array<{ name?: string }>;
      const hosts = (servers ?? []).map((server) => server.name).filter((name): name is string => Boolean(name));
      if (hosts.length > 0) this.mirrorHosts = hosts;
    } catch {
      // Discovery failing is not fatal - the seed FALLBACK_MIRROR_HOSTS list is still used.
    }
  }

  private async requestJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    await this.ensureMirrors();

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
    const baseParams = { limit, hidebroken: "true", order: "clickcount", reverse: "true" };

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
    const rows = await this.requestJson<RawStationRow[]>(`/json/stations/topclick/${limit}`, { hidebroken: "true" });
    return (rows ?? []).map(mapStation);
  }
}

export default new RadioBrowserClient();
