// Owner 2026-11-03: the licence PDF in Chinese. pdf-lib's own font subsetting drops most
// Chinese characters of a large font, so the Chinese font is cut down first by HarfBuzz
// (its official WebAssembly build) to exactly the characters on the page, then embedded whole.
// deno-lint-ignore-file no-explicit-any

const WASM = "https://cdn.jsdelivr.net/npm/harfbuzzjs@1.6.3/dist/harfbuzz-subset.wasm";
const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

let hbPromise: Promise<any> | null = null;

function harfbuzz(): Promise<any> {
  if (!hbPromise) {
    hbPromise = (async () => {
      const response = await fetch(WASM);
      if (!response.ok) throw new Error(`fetch ${WASM}: ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      const hb = instance.exports as any;
      hb._initialize();
      return hb;
    })().catch((error) => {
      hbPromise = null;
      throw error;
    });
  }
  return hbPromise;
}

/** A TrueType font holding only the glyphs for these characters (and their layout forms). */
export async function subsetFont(font: Uint8Array, text: string): Promise<Uint8Array> {
  const hb = await harfbuzz();
  const heap = () => new Uint8Array(hb.memory.buffer);
  const input = hb.hb_subset_input_create_or_fail();
  if (!input) throw new Error("harfbuzz: no subset input");
  const buffer = hb.malloc(font.byteLength);
  heap().set(font, buffer);
  const blob = hb.hb_blob_create(buffer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  try {
    // keep every layout feature, like --layout-features=*
    const features = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
    hb.hb_set_clear(features);
    hb.hb_set_invert(features);
    const unicodes = hb.hb_subset_input_unicode_set(input);
    for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0)!);
    const subset = hb.hb_subset_or_fail(face, input);
    if (!subset) throw new Error("harfbuzz: subset failed");
    const result = hb.hb_face_reference_blob(subset);
    const offset = hb.hb_blob_get_data(result, 0);
    const length = hb.hb_blob_get_length(result);
    const out = heap().slice(offset, offset + length);
    hb.hb_blob_destroy(result);
    hb.hb_face_destroy(subset);
    if (!length) throw new Error("harfbuzz: empty subset");
    return out;
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(buffer);
  }
}
