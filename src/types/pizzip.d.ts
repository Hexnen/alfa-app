/**
 * PizZip nie dostarcza własnych typów (`node_modules/pizzip` ma tylko JS),
 * a `@types/pizzip` nie istnieje. Deklarujemy TYLE, ile realnie wołamy przy
 * szablonach umów: wczytanie archiwum, odczyt/zapis pojedynczego wpisu i lista
 * wpisów (src/lib/contract-templates/render.ts, scripts/umowy/tag-docx-template.ts).
 *
 * Świadomie nie odwzorowujemy całego API — szerszy stub bez oparcia w źródle
 * kłamałby przy pierwszej zmianie wersji, a te cztery metody są stabilne
 * od PizZip 3.0.
 */
declare module "pizzip" {
  interface PizZipObject {
    name: string;
    dir: boolean;
    asText(): string;
    asBinary(): string;
    asUint8Array(): Uint8Array;
    asNodeBuffer(): Buffer;
    asArrayBuffer(): ArrayBuffer;
  }

  interface PizZipGenerateOptions {
    type?: "base64" | "string" | "uint8array" | "arraybuffer" | "blob" | "nodebuffer";
    compression?: "STORE" | "DEFLATE";
    compressionOptions?: { level: number } | null;
    comment?: string;
    platform?: "DOS" | "UNIX";
    mimeType?: string;
  }

  interface PizZipFileOptions {
    base64?: boolean;
    binary?: boolean;
    date?: Date;
    compression?: "STORE" | "DEFLATE";
    createFolders?: boolean;
    dir?: boolean;
    comment?: string;
  }

  class PizZip {
    constructor(data?: Buffer | Uint8Array | ArrayBuffer | string, options?: { base64?: boolean; checkCRC32?: boolean });
    files: Record<string, PizZipObject>;
    file(name: string): PizZipObject | null;
    file(name: string, data: string | Buffer | Uint8Array | ArrayBuffer, options?: PizZipFileOptions): PizZip;
    remove(name: string): PizZip;
    generate(options?: PizZipGenerateOptions): string | Uint8Array | ArrayBuffer | Buffer;
  }

  export = PizZip;
}
