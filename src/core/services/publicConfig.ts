// Switches the first screen reads before anyone signs in (2026-11-01): set from
// the Platform Manager, served by the public-config function. Any failure keeps
// the defaults, so the screen never waits on the network.
export interface PublicConfig {
  showWebLink: boolean;
  apkDistributionEnabled: boolean;
}

export const DEFAULT_PUBLIC_CONFIG: PublicConfig = { showWebLink: true, apkDistributionEnabled: true };

const TIMEOUT_MS = 4000;

export async function readPublicConfig(): Promise<PublicConfig> {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) return DEFAULT_PUBLIC_CONFIG;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/functions/v1/public-config`, { signal: controller.signal });
    if (!response.ok) return DEFAULT_PUBLIC_CONFIG;
    const data = (await response.json()) as Partial<PublicConfig>;
    return {
      showWebLink: data.showWebLink !== false,
      apkDistributionEnabled: data.apkDistributionEnabled !== false,
    };
  } catch {
    return DEFAULT_PUBLIC_CONFIG;
  } finally {
    clearTimeout(timer);
  }
}
