// Audit 5.3 (2026-10-13) - compares a presented secret with the expected
// one in constant time. Both are hashed first (SHA-256), so the timing
// reveals neither how many leading characters match nor the length.
export async function secretsMatch(presented: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
