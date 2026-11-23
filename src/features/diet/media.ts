/** Miniatura quadrata (lato 160 px) per il diario: leggera, resta solo sul telefono. */
export async function makeThumb(blob: Blob, side = 160): Promise<Blob | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = side;
    c.height = side;
    c.getContext('2d')!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, side, side);
    bmp.close();
    return await new Promise<Blob | undefined>((res) => c.toBlob((b) => res(b ?? undefined), 'image/jpeg', 0.72));
  } catch {
    return undefined;
  }
}
