import sharp from "sharp";

export interface Bbox {
  x: number; // 0–1
  y: number;
  w: number;
  h: number;
}

function bboxToPixels(bbox: Bbox, width: number, height: number) {
  // Clamp the normalized box into bounds: an expert's view_region bbox isn't
  // schema-validated at call time, so an out-of-range value would otherwise
  // produce a negative/out-of-bounds extract that makes sharp throw. Keep the
  // origin at most one pixel inside each edge so the crop is always ≥ 1px.
  const x = Math.min(Math.max(bbox.x, 0), 1);
  const y = Math.min(Math.max(bbox.y, 0), 1);
  const left = Math.min(Math.round(x * width), width - 1);
  const top = Math.min(Math.round(y * height), height - 1);
  const cropW = Math.max(1, Math.min(Math.round(bbox.w * width), width - left));
  const cropH = Math.max(1, Math.min(Math.round(bbox.h * height), height - top));
  return { left, top, cropW, cropH };
}

/**
 * Crop a PNG file to the given normalized bbox (0–1) and return the result as a base64 string.
 */
export async function cropImageToBase64(imgPath: string, bbox: Bbox): Promise<string> {
  const img = sharp(imgPath);
  const { width, height } = await img.metadata();
  if (!width || !height) throw new Error("Could not read image dimensions");

  const { left, top, cropW, cropH } = bboxToPixels(bbox, width, height);
  const cropped = await img.extract({ left, top, width: cropW, height: cropH }).png().toBuffer();
  return cropped.toString("base64");
}

/**
 * Crop a PNG file to the given normalized bbox and return the raw Buffer.
 */
export async function cropImageToBuffer(imgPath: string, bbox: Bbox): Promise<Buffer> {
  const img = sharp(imgPath);
  const { width, height } = await img.metadata();
  if (!width || !height) throw new Error("Could not read image dimensions");

  const { left, top, cropW, cropH } = bboxToPixels(bbox, width, height);
  return img.extract({ left, top, width: cropW, height: cropH }).png().toBuffer();
}
