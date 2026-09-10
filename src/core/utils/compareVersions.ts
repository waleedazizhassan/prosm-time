// PROSM Time - a tiny real semver-shaped comparator ("2.3.1" vs
// "2.3.10" must sort numerically per segment, not as strings) for
// UpdateAvailableBanner.tsx - not a full semver library (no
// pre-release/build-metadata parsing), which this app's own plain
// "major.minor.patch" versioning never needs.
export function isVersionNewer(remote: string, current: string): boolean {
  const remoteParts = remote.split(".").map((part) => parseInt(part, 10) || 0);
  const currentParts = current.split(".").map((part) => parseInt(part, 10) || 0);
  const length = Math.max(remoteParts.length, currentParts.length);
  for (let i = 0; i < length; i += 1) {
    const r = remoteParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}
