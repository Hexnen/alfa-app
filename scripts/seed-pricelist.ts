// Jednorazowy seed cennika z "CENNIK USŁUG SERWISOWYCH" (wer. 20260127,
// załącznik do protokołu powykonawczego).
import { db, schema } from "../src/db/index.js";

const ITEMS: (typeof schema.priceList.$inferInsert)[] = [
  { position: 1, name: "DOJAZD NA OBIEKT POZA WARSZAWĄ", unit: "KM", price: 1.8 },
  { position: 2, name: "PIERWSZA ROZPOCZĘTA GODZINA PRACY INSTALATORA", unit: "RBH", price: 450 },
  { position: 3, name: "KOLEJNA ROZPOCZĘTA GODZINA PRACY INSTALATORA", unit: "RBH", price: 145 },
  { position: 4, name: "KABEL UTP KAT 5E.", unit: "MB", price: 3 },
  { position: 5, name: "KABEL ZASILAJĄCY", unit: "MB", price: 4.2 },
  { position: 6, name: "PESZEL: RURA KARBOWANA", unit: "MB", price: 4.2 },
  { position: 7, name: "PRACE ZIEMNE", unit: "MB", price: 24 },
  { position: 8, name: "UŁOŻENIE RURKI/LISTWY INSTALACYJNEJ", unit: "MB", price: 6 },
  { position: 9, name: "DEMONTAŻ/MONTAŻ KOSTKI BRUKOWEJ", unit: "MB", price: 78 },
  { position: 10, name: "WYKONANIE BRUZDY W TYNKU (BEZ MALOWANIA TYLKO GIPSUJEMY)", unit: "MB", price: 24 },
];

const existing = await db.select().from(schema.priceList);
if (existing.length > 0) {
  console.log(`Pomijam seed — cennik ma już ${existing.length} pozycji.`);
} else {
  await db.insert(schema.priceList).values(ITEMS);
  console.log(`Dodano ${ITEMS.length} pozycji cennika.`);
}
process.exit(0);
