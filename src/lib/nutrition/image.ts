/**
 * Compressione delle foto nel browser prima dell'invio a Gemini: lato lungo 1024 px, JPEG.
 * Ridisegnare l'immagine su un canvas elimina anche i metadati EXIF (posizione GPS compresa).
 */
import { GeminiError } from './gemini';

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
}

/** Dimensioni che stanno dentro un quadrato di lato maxSide mantenendo le proporzioni (mai ingrandite). */
export function fitWithin(width: number, height: number, maxSide = 1024): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height };
  const k = maxSide / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

async function decode(input: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(input, { imageOrientation: 'from-image' });
    } catch {
      // alcuni browser non decodificano tutti i formati con createImageBitmap: si prova con <img>
    }
  }
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new GeminiError('immagine-non-valida', 'Non riesco ad aprire la foto in questo ambiente.');
  }
  const url = URL.createObjectURL(input);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new GeminiError('immagine-non-valida', 'Non riesco ad aprire la foto: prova con una foto JPEG o PNG.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Ridimensiona e ricomprime in JPEG. */
export async function compressImage(input: Blob, maxSide = 1024, quality = 0.85): Promise<CompressedImage> {
  if (!(input instanceof Blob) || input.size === 0) throw new GeminiError('immagine-non-valida', 'La foto è vuota.');
  const src = await decode(input);
  const w0 = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h0 = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const { width, height } = fitWithin(w0, h0, maxSide);
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new GeminiError('immagine-non-valida', 'Il browser non riesce a elaborare la foto.');
    ctx.drawImage(src, 0, 0, width, height);
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new GeminiError('immagine-non-valida', 'Il browser non riesce a elaborare la foto.');
    ctx.drawImage(src, 0, 0, width, height);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new GeminiError('immagine-non-valida', 'Compressione della foto non riuscita.'))), 'image/jpeg', quality),
    );
  }
  if ('close' in src && typeof src.close === 'function') src.close();
  return { blob, width, height };
}
