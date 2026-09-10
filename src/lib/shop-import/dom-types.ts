/**
 * Typy adaptera DOM w osobnym pliku, żeby parsery mogły je importować bez
 * wciągania implementacji (i żeby nie zależeć od `domhandler`, który jest tylko
 * zależnością przechodnią cheerio — jego typy nie są częścią naszego API).
 */
import type * as cheerio from "cheerio";

/** Kolekcja elementów cheerio; węzły trzymamy nietypowane świadomie. */
export type Sel = cheerio.Cheerio<any>;

export interface Doc {
  $: cheerio.CheerioAPI;
  /** Sparsowane bloki `application/ld+json` (te niepoprawne są pominięte). */
  jsonLd: unknown[];
  /** Surowy HTML — potrzebny do rzeczy, których nie ma w drzewie (komentarz „saved from url”). */
  html: string;
}
