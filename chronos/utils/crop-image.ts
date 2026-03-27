import sharp from "sharp";

export interface Bbox {
  x: number; // 0–1
  y: number;
  w: number;
  h: number;
}

function bboxToPixels(bbox: Bbox, width: number, height: number) {
  const left = Math.round(bbox.x * width);
  const top = Math.round(bbox.y * height);
  const cropW = Math.min(Math.round(bbox.w * width), width - left);
  const cropH = Math.min(Math.round(bbox.h * height), height - top);
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
