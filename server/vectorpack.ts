// Compact on-disk format for a trimmed, unit-normalised word-embedding table.
//
// Layout (little-endian):
//
//   magic       4 bytes   "CWVP"
//   version     u32       = 1
//   count       u32       number of words
//   dim         u32       vector dimensionality
//   flags       u32       bit 0 = synthetic sample pack
//   vocabBytes  u32       byte length of the vocab blob
//   vocab       UTF-8     words joined by "\n", in descending corpus frequency
//   pad         0..3      zero bytes so the matrix starts 4-byte aligned
//   matrix      f32[]     count * dim, row-major, each row L2-normalised
//
// Rows are pre-normalised so cosine similarity is a plain dot product, which is
// the whole reason the ranker can score a 50k vocabulary in single-digit ms.

export const PACK_MAGIC = "CWVP";
export const PACK_VERSION = 1;
const HEADER_BYTES = 24;

export interface VectorPack {
  words: string[];
  /** Word -> row index. */
  index: Map<string, number>;
  matrix: Float32Array;
  dim: number;
  count: number;
  sample: boolean;
}

export function encodePack(
  words: string[],
  matrix: Float32Array,
  dim: number,
  sample: boolean,
): Uint8Array {
  const count = words.length;
  if (matrix.length !== count * dim) {
    throw new Error(`matrix length ${matrix.length} != ${count} * ${dim}`);
  }
  const vocabBytes = new TextEncoder().encode(words.join("\n"));
  const pad = (4 - ((HEADER_BYTES + vocabBytes.length) % 4)) % 4;
  const matrixOffset = HEADER_BYTES + vocabBytes.length + pad;
  const out = new Uint8Array(matrixOffset + matrix.byteLength);
  const view = new DataView(out.buffer);

  for (let i = 0; i < 4; i++) out[i] = PACK_MAGIC.charCodeAt(i);
  view.setUint32(4, PACK_VERSION, true);
  view.setUint32(8, count, true);
  view.setUint32(12, dim, true);
  view.setUint32(16, sample ? 1 : 0, true);
  view.setUint32(20, vocabBytes.length, true);
  out.set(vocabBytes, HEADER_BYTES);
  // `out.buffer` is freshly allocated and matrixOffset is 4-byte aligned, so a
  // Float32Array view over it is safe.
  new Float32Array(out.buffer, matrixOffset, matrix.length).set(matrix);
  return out;
}

export function decodePack(bytes: Uint8Array): VectorPack {
  if (bytes.length < HEADER_BYTES) throw new Error("vector pack truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== PACK_MAGIC) throw new Error(`not a vector pack (magic ${JSON.stringify(magic)})`);
  const version = view.getUint32(4, true);
  if (version !== PACK_VERSION) throw new Error(`unsupported pack version ${version}`);
  const count = view.getUint32(8, true);
  const dim = view.getUint32(12, true);
  const sample = (view.getUint32(16, true) & 1) === 1;
  const vocabBytes = view.getUint32(20, true);

  const vocabStart = bytes.byteOffset + HEADER_BYTES;
  const vocabRaw = new Uint8Array(bytes.buffer, vocabStart, vocabBytes);
  const words = new TextDecoder().decode(vocabRaw).split("\n");
  if (words.length !== count) {
    throw new Error(`vocab has ${words.length} words but header says ${count}`);
  }

  const pad = (4 - ((HEADER_BYTES + vocabBytes) % 4)) % 4;
  const matrixOffset = bytes.byteOffset + HEADER_BYTES + vocabBytes + pad;
  const expected = count * dim;
  if (matrixOffset + expected * 4 > bytes.byteOffset + bytes.byteLength) {
    throw new Error("vector pack matrix truncated");
  }
  // Copy only if the source buffer is not 4-byte aligned at the matrix start.
  const matrix = matrixOffset % 4 === 0
    ? new Float32Array(bytes.buffer, matrixOffset, expected)
    : new Float32Array(
      bytes.buffer.slice(matrixOffset, matrixOffset + expected * 4),
    );

  const index = new Map<string, number>();
  for (let i = 0; i < words.length; i++) index.set(words[i], i);

  return { words, index, matrix, dim, count, sample };
}

/** Normalise `row` in place to unit length. Zero vectors are left untouched. */
export function normaliseRow(matrix: Float32Array, offset: number, dim: number): void {
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const v = matrix[offset + i];
    sum += v * v;
  }
  if (sum === 0) return;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < dim; i++) matrix[offset + i] *= inv;
}
