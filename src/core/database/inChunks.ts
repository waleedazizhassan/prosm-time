// v2.3.50 (owner 2026-10-26: "tapping the attendance card says the records
// could not be loaded"): a filter on a long list of ids travels in the
// request's address, and a month of sessions (and twice as many events) made
// it longer than the server gateway accepts - the request failed. The list is
// sent in batches instead; each batch is filtered by its own ids, so every
// row of one id stays in one batch, in the query's own order.
export const ID_BATCH = 50;

export async function selectInChunks<T>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  size = ID_BATCH,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += size) {
    const result = await run(ids.slice(start, start + size));
    if (result.error) return { data: rows, error: result.error };
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null };
}
