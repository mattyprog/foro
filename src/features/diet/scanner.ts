/**
 * Lettore di codici a barre: BarcodeDetector nativo dove c'è (Chrome su Android),
 * altrimenti la versione WebAssembly di ZXing servita dall'app stessa (iPhone, Firefox), scaricata al primo uso.
 */
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]> };

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let cached: Promise<Detector> | null = null;

export function getDetector(): Promise<Detector> {
  if (cached) return cached;
  cached = (async () => {
    const Native = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
    if (Native?.getSupportedFormats) {
      try {
        const sup = await Native.getSupportedFormats();
        if (sup.includes('ean_13')) return new Native({ formats: FORMATS.filter((f) => sup.includes(f)) });
      } catch {
        /* ripiego su ZXing */
      }
    }
    const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
      import('barcode-detector/ponyfill'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) },
    });
    return new BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector;
  })();
  return cached;
}
