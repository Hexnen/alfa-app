/**
 * ETAP "KANDYDACI" — przygotowanie materiału do ręcznego dopasowania obiektów do kontrahentów.
 *
 * Czyta (tylko do odczytu, nic nie zapisuje do bazy):
 *  - obiekty/KONTRAHENCI.XLSX (arkusz "Sheet")   — kartoteka kontrahentów z księgowości
 *  - obiekty/OBIEKTY.XLSX ("alfa group", "alfa s", "SK")
 *  - data/alfa.db: monitored_objects (416), hr_objects (42)
 *
 * Wypluwa do OUT_DIR (domyślnie $S/baza):
 *  - kandydaci.json
 *  - kandydaci-cma-1.md / -2.md / -3.md
 *  - kandydaci-faktury.md
 *  - kandydaci-sk-hr.md
 *
 * Uruchomienie:
 *   export PATH=/config/.nvm/versions/node/v22.22.0/bin:$PATH
 *   npx tsx scripts/baza-obiektowa/kandydaci.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';

const readWorkbook = (p: string) => XLSX.read(fs.readFileSync(p), { type: 'buffer' });

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR =
  process.env.OUT_DIR ||
  '/tmp/claude-1000/-config-workspace-programming-alfa-app/913bea21-d7b7-43f1-929f-335f6f89b018/scratchpad/baza';
const DB_PATH = process.env.ALFA_DB_PATH || path.join(ROOT, 'data/alfa.db');

// ─────────────────────────────────────────────────────────────── normalizacja

const PL_MAP: Record<string, string> = {
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
  ą: 'A', ć: 'C', ę: 'E', ł: 'L', ń: 'N', ó: 'O', ś: 'S', ź: 'Z', ż: 'Z',
};

function deaccent(s: string): string {
  return s.replace(/[ĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g, (c) => PL_MAP[c] ?? c);
}

/** Formy prawne / szum, usuwane z nazwy przed porównaniem. Kolejność ma znaczenie. */
const LEGAL_PATTERNS: Array<[RegExp, string]> = [
  [/\bSPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA SPOLKA KOMANDYTOWA\b/g, ' '],
  [/\bSPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA\b/g, ' '],
  [/\bSPOLKA KOMANDYTOWO ?- ?AKCYJNA\b/g, ' '],
  [/\bSPOLKA KOMANDYTOWA\b/g, ' '],
  [/\bSPOLKA AKCYJNA\b/g, ' '],
  [/\bSPOLKA JAWNA\b/g, ' '],
  [/\bSPOLKA CYWILNA\b/g, ' '],
  [/\bSPOLDZIELNIA MIESZKANIOWA\b/g, ' SM '],
  [/\bWSPOLNOTA MIESZKANIOWA\b/g, ' WM '],
  [/\bSP Z O ?O\b/g, ' '],
  [/\bSP ZOO\b/g, ' '],
  [/\bZ O ?O\b/g, ' '],
  [/\bSP K\b/g, ' '],
  [/\bSP J\b/g, ' '],
  [/\bS K A\b/g, ' '],
  [/\bS C\b/g, ' '],
  [/\bS A\b/g, ' '],
  [/\bSA\b/g, ' '],
  [/\bPPHU\b/g, ' '],
  [/\bPHU\b/g, ' '],
  [/\bFHU\b/g, ' '],
  [/\bFIRMA HANDLOWO ?- ?USLUGOWA\b/g, ' '],
  [/\bPRZEDSIEBIORSTWO HANDLOWO ?- ?USLUGOWE\b/g, ' '],
  [/\bZAKLAD USLUGOWY\b/g, ' '],
  [/\bODDZIAL W POLSCE\b/g, ' '],
];

/** Słowa opisowe, które w nazwach obiektów CMA są "szumem" (budowa, miasto-opis itd.). */
const STOPWORDS = new Set([
  'BUDOWA', 'BUDOWY', 'INWESTYCJA', 'INWESTYCJI', 'OBIEKT', 'OBIEKTU', 'TEREN', 'TERENU',
  'PLAC', 'PLACU', 'MAGAZYN', 'MAGAZYNU', 'BIURO', 'BIURA', 'HALA', 'HALI', 'STACJA',
  'STACJI', 'FARMA', 'FARMY', 'FOTOWOLTAICZNA', 'FOTOWOLTAICZNEJ', 'PV', 'ROZBIORKA',
  'ROZBIORKI', 'UL', 'ULICA', 'AL', 'ALEJA', 'OS', 'OSIEDLE', 'NR', 'DOM', 'DOMU',
  'SKLEP', 'SALON', 'SERWIS', 'PARKING', 'ZDW', 'ZDV', 'CMA', 'OFI', 'MONITORING',
  'DOZOR', 'OCHRONA', 'KAMERY', 'WIEZA', 'WIEZE', 'I', 'W', 'NA', 'ORAZ', 'DLA', 'THE',
  'ETAP', 'II', 'III', 'IV',
]);

function normName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = deaccent(String(raw)).toUpperCase();
  s = s.replace(/["'`„”»«]/g, ' ');
  s = s.replace(/[^A-Z0-9]+/g, ' ');
  s = ` ${s.trim()} `;
  for (const [re, rep] of LEGAL_PATTERNS) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

function tokens(norm: string): string[] {
  return norm.split(' ').filter((t) => t.length >= 2);
}

function contentTokens(norm: string): string[] {
  return tokens(norm).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function trigrams(s: string): Set<string> {
  const t = ` ${s.replace(/\s+/g, ' ')} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function normNip(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '');
}

function normCity(raw: unknown): string {
  return deaccent(String(raw ?? '')).toUpperCase().replace(/[^A-Z ]/g, '').trim();
}

// ─────────────────────────────────────────────────────── model / punktacja

interface Target {
  /** klucz identyfikujący element porównywany (NIP lub noNip:<ID>, albo nazwa) */
  key: string;
  /** etykieta do wyświetlenia */
  label: string;
  /** warianty nazw (aliasy) */
  variants: Array<{ norm: string; tokens: Set<string>; content: Set<string>; tri: Set<string> }>;
  city: string;
}

function mkVariant(raw: string) {
  const norm = normName(raw);
  return {
    norm,
    tokens: new Set(tokens(norm)),
    content: new Set(contentTokens(norm)),
    tri: trigrams(norm),
  };
}

interface Scored {
  key: string;
  name: string;
  score: number;
  why: string;
}

/**
 * Punktacja jednej pary (zapytanie ↔ cel).
 * Zwraca 0..1 + powód.
 */
function scorePair(
  qNorm: string,
  qTokens: Set<string>,
  qContent: Set<string>,
  qTri: Set<string>,
  qCity: string,
  target: Target,
): { score: number; why: string } | null {
  let best = 0;
  let bestWhy = '';
  for (const v of target.variants) {
    if (!v.norm) continue;
    const why: string[] = [];
    let score = 0;

    if (qNorm === v.norm) {
      score = 1;
      why.push('dokładna zgodność nazwy');
    } else {
      // zawieranie (nazwa kontrahenta jest prefiksem/fragmentem nazwy obiektu lub odwrotnie)
      const shorter = qNorm.length <= v.norm.length ? qNorm : v.norm;
      const longer = qNorm.length <= v.norm.length ? v.norm : qNorm;
      const contains =
        shorter.length >= 4 && (longer.startsWith(`${shorter} `) || longer.includes(` ${shorter} `) || longer === shorter);
      if (contains) {
        const ratio = shorter.length / longer.length;
        score = Math.max(score, 0.72 + 0.25 * ratio);
        why.push(longer.startsWith(`${shorter} `) ? 'nazwa zaczyna się od kontrahenta' : 'zawieranie nazwy');
      }

      // Jaccard tokenów treściowych (mocniejszy) i wszystkich (słabszy)
      const jc = jaccard(qContent, v.content);
      const jt = jaccard(qTokens, v.tokens);
      const j = Math.max(jc, jt * 0.9);
      if (j > 0) {
        score = Math.max(score, 0.15 + 0.75 * j);
        if (j >= 0.3) why.push(`wspólne tokeny (J=${j.toFixed(2)})`);
      }

      // najdłuższy wspólny token ≥ 4 znaki
      let longestCommon = '';
      for (const t of qContent) if (v.content.has(t) && t.length > longestCommon.length) longestCommon = t;
      if (longestCommon.length >= 4) {
        const rare = 0.5 + Math.min(0.35, longestCommon.length / 24);
        score = Math.max(score, rare);
        why.push(`wspólny token "${longestCommon}"`);
      }

      // trigramy — łapią literówki i odmiany
      const jtri = jaccard(qTri, v.tri);
      if (jtri >= 0.35) {
        score = Math.max(score, 0.35 + 0.55 * jtri);
        why.push(`trigramy ${jtri.toFixed(2)}`);
      } else if (jtri > 0) {
        score = Math.max(score, jtri * 0.6);
      }
    }

    if (score <= 0) continue;

    if (qCity && target.city && qCity === target.city) {
      score = Math.min(1, score + 0.08);
      why.push(`miasto ${target.city}`);
    }

    if (score > best) {
      best = score;
      bestWhy = why.join(', ') || 'słabe podobieństwo';
    }
  }
  if (best <= 0) return null;
  return { score: Math.min(1, best), why: bestWhy };
}

interface QuerySource {
  text: string;
  weight: number;
  /** skąd pochodzi tekst — trafia do opisu "why" gdy to nie jest główna nazwa */
  tag?: string;
}

/** Liczy TOP-N kandydatów dla zapytania złożonego z kilku źródeł tekstu o różnych wagach. */
function topCandidates(sources: QuerySource[], city: string, targets: Target[], n = 5): Scored[] {
  const prepared = sources
    .filter((s) => s.text && normName(s.text))
    .map((s) => {
      const norm = normName(s.text);
      return {
        weight: s.weight,
        tag: s.tag,
        norm,
        tokens: new Set(tokens(norm)),
        content: new Set(contentTokens(norm)),
        tri: trigrams(norm),
        isPrimary: !s.tag,
      };
    });
  if (!prepared.length) return [];

  const acc = new Map<string, Scored>();
  for (const t of targets) {
    let best: Scored | null = null;
    for (const p of prepared) {
      const r = scorePair(p.norm, p.tokens, p.content, p.tri, city, t);
      if (!r) continue;
      const s = r.score * p.weight;
      if (!best || s > best.score) {
        best = {
          key: t.key,
          name: t.label,
          score: Math.min(1, s),
          why: p.isPrimary ? r.why : `${r.why} [${p.tag}]`,
        };
      }
    }
    if (best && best.score >= 0.2) {
      const prev = acc.get(t.key);
      if (!prev || best.score > prev.score) acc.set(t.key, best);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, n);
}

// ───────────────────────────────────────────────────────────── wczytywanie

interface ContractorRow {
  id: number;
  nazwa: string;
  pelna: string;
  nip: string;
  city: string;
  street: string;
}

interface ContractorGroup {
  key: string; // NIP albo noNip:<ID>
  nip: string | null;
  names: string[]; // aliasy ("Nazwa firmy")
  fullNames: string[];
  primaryName: string;
  city: string;
  street: string;
  ids: number[];
}

function loadContractors(): ContractorGroup[] {
  const wb = readWorkbook(path.join(ROOT, 'obiekty/KONTRAHENCI.XLSX'));
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Sheet'], { defval: '' });
  const parsed: ContractorRow[] = rows.map((r) => ({
    id: Number(r['ID']),
    nazwa: String(r['Nazwa firmy'] ?? '').trim(),
    pelna: String(r['Pełna nazwa firmy'] ?? '').trim(),
    nip: normNip(r['Nip']),
    city: String(r['Miejscowość'] ?? '').trim(),
    street: [String(r['Ulica'] ?? '').trim(), String(r['Nr'] ?? '').trim()].filter(Boolean).join(' '),
  }));

  const byKey = new Map<string, ContractorGroup>();
  for (const r of parsed) {
    const key = r.nip ? r.nip : `noNip:${r.id}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        nip: r.nip || null,
        names: [],
        fullNames: [],
        primaryName: '',
        city: r.city,
        street: r.street,
        ids: [],
      };
      byKey.set(key, g);
    }
    g.ids.push(r.id);
    if (r.nazwa && !g.names.includes(r.nazwa)) g.names.push(r.nazwa);
    if (r.pelna && !g.fullNames.includes(r.pelna)) g.fullNames.push(r.pelna);
    if (!g.city && r.city) g.city = r.city;
    if (!g.street && r.street) g.street = r.street;
  }
  for (const g of byKey.values()) {
    // "Pełna nazwa" jest wiarygodniejsza niż etykieta typu "T-MOBILE 7965"
    g.primaryName = g.fullNames[0] || g.names[0] || '';
  }
  return [...byKey.values()];
}

function contractorTargets(groups: ContractorGroup[]): Target[] {
  return groups.map((g) => {
    const raws = [...new Set([...g.fullNames, ...g.names])].filter(Boolean);
    return {
      key: g.key,
      label: g.primaryName + (g.names.length && g.names[0] !== g.primaryName ? ` (alias: ${g.names.join(' | ')})` : ''),
      variants: raws.map(mkVariant),
      city: normCity(g.city),
    };
  });
}

interface CmaRow {
  external_id: number;
  name: string;
  address: string | null;
  city: string | null;
  groups: string | null;
  identifier1: string | null;
  extra_data1: string | null;
  extra_data2: string | null;
  object_description: string | null;
  location_description: string | null;
  authorized_persons: string | null;
  object_status: string | null;
  monitoring_start: string | null;
  monitoring_end: string | null;
  default_crew: string | null;
}

function loadCma(): CmaRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      `SELECT external_id, name, address, city, groups, identifier1, extra_data1, extra_data2,
              object_description, location_description, authorized_persons, object_status,
              monitoring_start, monitoring_end, default_crew
       FROM monitored_objects ORDER BY name COLLATE NOCASE`,
    )
    .all() as CmaRow[];
  db.close();
  return rows;
}

function loadHr(): string[] {
  const SKIP = new Set(['#BIURO', '#ZLECENIE', 'BIURO', 'KIEROWNIK', 'KONTROLNY']);
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare('SELECT name FROM hr_objects ORDER BY name COLLATE NOCASE').all() as Array<{ name: string }>;
  db.close();
  return rows.map((r) => String(r.name).trim()).filter((n) => n && !SKIP.has(n.toUpperCase()));
}

interface InvoiceRow {
  sheet: string;
  flag: string;
  client: string;
  netto: number | null;
  brutto: number | null;
}

interface SkRow {
  company: string;
  object: string;
}

function loadObiekty(): { invoices: InvoiceRow[]; sk: SkRow[] } {
  const wb = readWorkbook(path.join(ROOT, 'obiekty/OBIEKTY.XLSX'));
  const invoices: InvoiceRow[] = [];
  for (const sheet of ['alfa group', 'alfa s']) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet], { defval: '' });
    for (const r of rows) {
      const client = String(r['Klient'] ?? '').trim();
      if (!client) continue;
      invoices.push({
        sheet,
        flag: String(r['Flaga'] ?? '').trim(),
        netto: r['Netto'] === '' ? null : Number(r['Netto']),
        brutto: r['Brutto'] === '' ? null : Number(r['Brutto']),
        client,
      });
    }
  }
  const sk: SkRow[] = XLSX.utils
    .sheet_to_json<Record<string, unknown>>(wb.Sheets['SK'], { defval: '' })
    .map((r) => ({ company: String(r['ALFASK'] ?? '').trim(), object: String(r['WOLNA'] ?? '').trim() }))
    .filter((r) => r.company || r.object);
  return { invoices, sk };
}

// ─────────────────────────────────────────────────── ekstrakcja nazw z pól CMA

/** Wyciąga nazwy firm z nawiasów, np. "Jan Kowalski (ALIANS-OZE)" → "ALIANS-OZE". */
function bracketNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of String(text).matchAll(/\(([^)]{3,60})\)/g)) {
    const v = m[1].trim();
    if (/kierownik|koordynator|dyrektor|właściciel|wlasciciel|prezes|ochrona|technicz|kontroln/i.test(v)) continue;
    out.push(v);
  }
  return out;
}

/** Pierwsze 1–3 tokeny nazwy CMA — zwykle to sama nazwa klienta. */
function namePrefixes(name: string): string[] {
  const parts = normName(name).split(' ').filter(Boolean);
  const out: string[] = [];
  for (const k of [1, 2, 3]) {
    if (parts.length > k) out.push(parts.slice(0, k).join(' '));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── main

function fmt(n: number): string {
  return n.toFixed(2);
}

function bucket(cands: Scored[]): 'pewny' | 'do sprawdzenia' | 'brak' {
  const s = cands[0]?.score ?? 0;
  if (s >= 0.9) return 'pewny';
  if (s >= 0.6) return 'do sprawdzenia';
  return 'brak';
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const contractors = loadContractors();
  const cTargets = contractorTargets(contractors);
  const cma = loadCma();
  const hr = loadHr();
  const { invoices, sk } = loadObiekty();

  console.log(
    `Wczytano: kontrahenci ${contractors.length} grup (NIP: ${contractors.filter((c) => c.nip).length}, bez NIP: ${
      contractors.filter((c) => !c.nip).length
    }), CMA ${cma.length}, faktury ${invoices.length}, SK ${sk.length}, hr_objects ${hr.length}`,
  );

  // cele pomocnicze: klienci z fakturowania, posterunki kadr, obiekty SK
  const invoiceTargets: Target[] = invoices.map((r, i) => ({
    key: `inv:${i}`,
    label: `[${r.sheet}/${r.flag}] ${r.client} — netto ${r.netto ?? '?'}`,
    variants: [mkVariant(r.client)],
    city: '',
  }));
  const hrTargets: Target[] = hr.map((n, i) => ({
    key: `hr:${i}`,
    label: n,
    variants: [mkVariant(n)],
    city: '',
  }));
  const skTargets: Target[] = sk
    .filter((r) => r.object)
    .map((r, i) => ({
      key: `sk:${i}`,
      label: `${r.object} (${r.company})`,
      variants: [mkVariant(r.object)],
      city: '',
    }));
  const postTargets = [...hrTargets, ...skTargets];

  // ── CMA
  const cmaOut = cma.map((o) => {
    const city = normCity(o.city);
    const sources: QuerySource[] = [{ text: o.name, weight: 1 }];
    for (const p of namePrefixes(o.name)) sources.push({ text: p, weight: 0.95, tag: 'początek nazwy obiektu' });
    for (const b of [
      ...bracketNames(o.authorized_persons),
      ...bracketNames(o.object_description),
      ...bracketNames(o.location_description),
    ]) {
      sources.push({ text: b, weight: 0.8, tag: 'nazwa w nawiasie (osoby/opis)' });
    }
    if (o.object_description) sources.push({ text: o.object_description.slice(0, 120), weight: 0.55, tag: 'opis obiektu' });

    const candidates = topCandidates(sources, city, cTargets);
    const invoiceCandidates = topCandidates(sources, '', invoiceTargets);
    const hrCandidates = topCandidates(sources, '', postTargets);
    return {
      external_id: o.external_id,
      name: o.name,
      address: o.address,
      city: o.city,
      groups: o.groups,
      identifier1: o.identifier1,
      price: o.extra_data1,
      extras: o.extra_data2,
      status: o.object_status,
      start: o.monitoring_start,
      end: o.monitoring_end,
      crew: o.default_crew,
      persons: o.authorized_persons ? o.authorized_persons.replace(/\s+/g, ' ').slice(0, 200) : null,
      candidates,
      invoiceCandidates,
      hrCandidates,
    };
  });

  // ── faktury
  const cmaTargets: Target[] = cma.map((o) => ({
    key: `cma:${o.external_id}`,
    label: `${o.name} [${o.external_id}]`,
    variants: [mkVariant(o.name)],
    city: normCity(o.city),
  }));

  const invoicesOut = invoices.map((r) => ({
    sheet: r.sheet,
    flag: r.flag,
    client: r.client,
    netto: r.netto,
    brutto: r.brutto,
    candidates: topCandidates([{ text: r.client, weight: 1 }], '', cTargets),
    cmaCandidates: topCandidates([{ text: r.client, weight: 1 }], '', cmaTargets),
  }));

  // ── SK
  const skOut = sk.map((r) => ({
    company: r.company,
    object: r.object,
    hrCandidates: r.object ? topCandidates([{ text: r.object, weight: 1 }], '', hrTargets) : [],
    contractorCandidates: r.object ? topCandidates([{ text: r.object, weight: 1 }], '', cTargets) : [],
    cmaCandidates: r.object ? topCandidates([{ text: r.object, weight: 1 }], '', cmaTargets) : [],
  }));

  // ── HR
  const hrOut = hr.map((n) => ({
    name: n,
    contractorCandidates: topCandidates([{ text: n, weight: 1 }], '', cTargets),
    cmaCandidates: topCandidates([{ text: n, weight: 1 }], '', cmaTargets),
  }));

  // ── JSON
  const json = {
    generatedAt: new Date().toISOString(),
    contractors: contractors.map((c) => ({
      key: c.key,
      nip: c.nip,
      name: c.primaryName,
      aliases: c.names,
      fullNames: c.fullNames,
      city: c.city,
      street: c.street,
      sourceIds: c.ids,
    })),
    cma: cmaOut,
    invoices: invoicesOut,
    sk: skOut,
    hr: hrOut,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'kandydaci.json'), JSON.stringify(json, null, 1));

  // ── markdown CMA (3 pliki)
  const renderCand = (c: Scored) => `  - ${fmt(c.score)} \`${c.key}\` — ${c.name} _(${c.why})_`;
  const cmaSections = cmaOut.map((o) => {
    const L: string[] = [];
    L.push(
      `### ${o.external_id} | ${o.name} | ${o.city ?? '-'} | ${o.groups ?? '-'} | ident1=${o.identifier1 ?? '-'} | cena=${
        o.price ?? '-'
      } | status=${o.status ?? 'NULL'} | ${o.start ?? '?'}–${o.end ?? '?'}`,
    );
    if (o.address) L.push(`adres: ${o.address}`);
    if (o.extras) L.push(`dopłaty: ${o.extras}`);
    if (o.crew) L.push(`patrol: ${o.crew}`);
    if (o.persons) L.push(`osoby: ${o.persons}`);
    L.push('');
    L.push(`kontrahenci (${bucket(o.candidates)}):`);
    L.push(...(o.candidates.length ? o.candidates.map(renderCand) : ['  - (brak)']));
    if (o.invoiceCandidates.length) {
      L.push('fakturowanie:');
      L.push(...o.invoiceCandidates.map(renderCand));
    }
    if (o.hrCandidates.length) {
      L.push('posterunki kadr/SK:');
      L.push(...o.hrCandidates.map(renderCand));
    }
    L.push('');
    L.push('DECYZJA: ');
    L.push('');
    return L.join('\n');
  });

  const per = Math.ceil(cmaSections.length / 3);
  for (let i = 0; i < 3; i++) {
    const chunk = cmaSections.slice(i * per, (i + 1) * per);
    const head = [
      `# Kandydaci CMA — część ${i + 1}/3`,
      '',
      `Obiekty ${i * per + 1}–${i * per + chunk.length} z ${cmaSections.length} (alfabetycznie po nazwie).`,
      'Format: `score \\`klucz\\` — nazwa (powód)`. Klucz kontrahenta = NIP albo `noNip:<ID>`.',
      'Wpisz wybór w linii `DECYZJA:` (NIP / noNip:ID / NOWY / WEWNĘTRZNY / BRAK).',
      '',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, `kandydaci-cma-${i + 1}.md`), head + chunk.join('\n---\n\n'));
  }
  // scalony podgląd
  fs.writeFileSync(
    path.join(OUT_DIR, 'kandydaci-cma.md'),
    `# Kandydaci CMA — wszystkie ${cmaSections.length} obiektów\n\n---\n\n${cmaSections.join('\n---\n\n')}`,
  );

  // ── markdown faktury
  {
    const L: string[] = ['# Kandydaci — fakturowanie (arkusze "alfa group" / "alfa s")', ''];
    for (const sheet of ['alfa group', 'alfa s']) {
      const rows = invoicesOut.filter((r) => r.sheet === sheet);
      L.push(`## ${sheet} (${rows.length})`, '');
      for (const r of rows) {
        L.push(`### [${r.flag}] ${r.client} — netto ${r.netto ?? '?'} / brutto ${r.brutto ?? '?'}`);
        L.push(`kontrahenci (${bucket(r.candidates)}):`);
        L.push(...(r.candidates.length ? r.candidates.map(renderCand) : ['  - (brak)']));
        if (r.cmaCandidates.length) {
          L.push('obiekty CMA:');
          L.push(...r.cmaCandidates.map(renderCand));
        }
        L.push('', 'DECYZJA: ', '');
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, 'kandydaci-faktury.md'), L.join('\n'));
  }

  // ── markdown SK + HR
  {
    const L: string[] = ['# Kandydaci — SK (spółki komandytowe) i hr_objects (posterunki OFI)', ''];
    L.push(`## Arkusz SK (${skOut.length})`, '');
    for (const r of skOut) {
      L.push(`### ${r.company || '(brak spółki)'} — ${r.object || '(WOLNA pusta)'}`);
      if (r.object) {
        L.push(`kontrahenci (${bucket(r.contractorCandidates)}):`);
        L.push(...(r.contractorCandidates.length ? r.contractorCandidates.map(renderCand) : ['  - (brak)']));
        if (r.hrCandidates.length) {
          L.push('posterunki kadr:');
          L.push(...r.hrCandidates.map(renderCand));
        }
        if (r.cmaCandidates.length) {
          L.push('obiekty CMA:');
          L.push(...r.cmaCandidates.map(renderCand));
        }
      }
      L.push('', 'DECYZJA: ', '');
    }
    L.push(`## hr_objects (${hrOut.length})`, '');
    for (const r of hrOut) {
      L.push(`### ${r.name}`);
      L.push(`kontrahenci (${bucket(r.contractorCandidates)}):`);
      L.push(...(r.contractorCandidates.length ? r.contractorCandidates.map(renderCand) : ['  - (brak)']));
      if (r.cmaCandidates.length) {
        L.push('obiekty CMA:');
        L.push(...r.cmaCandidates.map(renderCand));
      }
      L.push('', 'DECYZJA: ', '');
    }
    fs.writeFileSync(path.join(OUT_DIR, 'kandydaci-sk-hr.md'), L.join('\n'));
  }

  // ── statystyki
  const stat = (arr: Array<{ candidates: Scored[] }>) => {
    const s = { pewny: 0, 'do sprawdzenia': 0, brak: 0 };
    for (const x of arr) s[bucket(x.candidates)]++;
    return s;
  };
  const sCma = stat(cmaOut);
  const sInv = stat(invoicesOut);
  const sSk = stat(skOut.filter((r) => r.object).map((r) => ({ candidates: r.contractorCandidates })));
  const sHr = stat(hrOut.map((r) => ({ candidates: r.contractorCandidates })));

  const line = (n: string, s: Record<string, number>, total: number) =>
    `${n.padEnd(22)} ≥0.9 pewne: ${String(s.pewny).padStart(3)} | 0.6–0.9: ${String(s['do sprawdzenia']).padStart(
      3,
    )} | <0.6 brak: ${String(s.brak).padStart(3)}  (razem ${total})`;

  console.log('\n=== STATYSTYKI ===');
  console.log(line('CMA (monitored_obj)', sCma, cmaOut.length));
  console.log(line('Faktury (group+s)', sInv, invoicesOut.length));
  console.log(line('SK (WOLNA)', sSk, skOut.filter((r) => r.object).length));
  console.log(line('hr_objects', sHr, hrOut.length));

  console.log('\n=== 15 najtrudniejszych obiektów CMA (najsłabszy najlepszy kandydat) ===');
  const hardest = [...cmaOut].sort((a, b) => (a.candidates[0]?.score ?? 0) - (b.candidates[0]?.score ?? 0)).slice(0, 15);
  for (const o of hardest) {
    const c = o.candidates[0];
    console.log(
      `${String(o.external_id).padStart(7)} ${o.name.slice(0, 48).padEnd(50)} ${
        c ? `${fmt(c.score)} → ${c.name.slice(0, 45)}` : '(zero kandydatów)'
      }`,
    );
  }

  console.log(`\nPliki w ${OUT_DIR}: kandydaci.json, kandydaci-cma.md, kandydaci-cma-{1,2,3}.md, kandydaci-faktury.md, kandydaci-sk-hr.md`);
}

main();
