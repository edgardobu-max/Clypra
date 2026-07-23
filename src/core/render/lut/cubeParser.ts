/**
 * .cube LUT Parser
 *
 * Parses the Adobe/IRIDAS .cube format (used by every LUT sold on Envato
 * Market and by every major color grading tool). Only 3D LUTs are supported
 * — 1D LUTs (LUT_1D_SIZE) are rejected since they cannot represent hue
 * shifts, which is what color-grading LUTs are bought for.
 *
 * Format reference:
 *   TITLE "..."            (optional)
 *   LUT_3D_SIZE N
 *   DOMAIN_MIN r g b        (optional, default 0 0 0)
 *   DOMAIN_MAX r g b        (optional, default 1 1 1)
 *   r g b                   (N*N*N data rows, blue-fastest / red-slowest... actually red-fastest)
 */

export interface ParsedCubeLut {
  /** Grid resolution per axis (e.g. 33 for a 33x33x33 LUT). */
  size: number;
  /** RGB triples, size*size*size*3 floats, laid out red-fastest as .cube specifies. */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  title?: string;
}

export function parseCubeLut(text: string): ParsedCubeLut {
  let size = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: number[] = [];

  const lines = text.split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("TITLE")) {
      const match = line.match(/TITLE\s+"([^"]*)"/);
      title = match?.[1];
      continue;
    }

    if (line.startsWith("LUT_1D_SIZE")) {
      throw new Error("1D LUTs are not supported — only 3D color-cube .cube files can be applied");
    }

    if (line.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }

    if (line.startsWith("DOMAIN_MIN")) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3) domainMin = [parts[0], parts[1], parts[2]];
      continue;
    }

    if (line.startsWith("DOMAIN_MAX")) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3) domainMax = [parts[0], parts[1], parts[2]];
      continue;
    }

    // Data row: three floats.
    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const r = parseFloat(parts[0]);
      const g = parseFloat(parts[1]);
      const b = parseFloat(parts[2]);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        rows.push(r, g, b);
      }
    }
  }

  if (size < 2) {
    throw new Error("Invalid .cube file: missing or malformed LUT_3D_SIZE");
  }

  const expected = size * size * size * 3;
  if (rows.length !== expected) {
    throw new Error(`Invalid .cube file: expected ${expected} values for a ${size}^3 LUT, got ${rows.length}`);
  }

  return {
    size,
    data: Float32Array.from(rows),
    domainMin,
    domainMax,
    title,
  };
}
