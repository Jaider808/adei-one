/**
 * ADEI-ONE — Declaraciones ambientales de dependencias SIN tipos propios
 * (mammoth, utif, imagetracerjs). Se declaran solo las APIs mínimas que usan
 * los runners del convertidor; los paquetes que ya traen tipos (xlsx, heic2any,
 * docx) no se tocan aquí.
 */

declare module 'mammoth' {
  /** Resultado de la conversión docx→html (fragmento HTML en `value`). */
  export interface MammothResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  /** Origen del docx: `buffer` (Node) o `arrayBuffer` (navegador). */
  export interface MammothDocInput {
    buffer?: ArrayBuffer
    arrayBuffer?: ArrayBuffer
    path?: string
  }
  export function convertToHtml(
    input: MammothDocInput,
    options?: Record<string, unknown>,
  ): Promise<MammothResult>
  const mammoth: {
    convertToHtml(input: MammothDocInput, options?: Record<string, unknown>): Promise<MammothResult>
  }
  export default mammoth
}

declare module 'utif' {
  /** IFD de una imagen TIFF decodificada por UTIF. */
  export interface UtifImage {
    width: number
    height: number
    data?: Uint8Array
    [tag: string]: unknown
  }
  /** API mínima de UTIF.js que usa el convertidor. */
  export interface UtifApi {
    decode(buffer: ArrayBuffer | Uint8Array): UtifImage[]
    decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: UtifImage): void
    toRGBA8(ifd: UtifImage): Uint8Array
  }
  const utif: UtifApi
  export default utif
}

declare module 'imagetracerjs' {
  /** Datos RGBA de píxeles que consume imagedataToSVG (como CanvasImageData). */
  export interface ImageTracerImgData {
    width: number
    height: number
    data: Uint8ClampedArray
  }
  /** API mínima de imagetracer.js: vectoriza un ImageData a SVG. */
  export interface ImageTracerApi {
    imagedataToSVG(imgd: ImageTracerImgData, options?: Record<string, unknown>): string
  }
  const tracer: ImageTracerApi
  export default tracer
}