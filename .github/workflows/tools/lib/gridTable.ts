/**
 * Parser for the Pandoc-style "grid table" Markdown that Adobe's DA/AEM
 * authoring pipeline exports (e.g. https://main--da-dc--adobecom.aem.live/.../*.md).
 * Sections are separated by a bare `---`; each section holds grid-table blocks
 * whose header row is `Block Name (variant, …)`.
 */

export interface Block {
  name: string;
  variants: string[];
  rows: string[][];
}

export interface Section {
  blocks: Block[];
}

export interface ParsedDocument {
  sections: Section[];
  linkReferences: Map<string, string>;
}

const isDivider = (line: string): boolean => /^\+[-=+]+\+$/.test(line.trim());

const isTableLine = (line: string): boolean => {
  const t = line.trim();
  return t.length >= 2 && t.startsWith('|') && t.endsWith('|');
};

function splitCells(line: string): string[] {
  const t = line.trim();
  const inner = t.slice(1, -1);
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

function parseHeader(text: string): { name: string; variants: string[] } {
  const match = text.match(/^(.*?)(?:\s*\(([^)]*)\))?$/);
  const name = (match?.[1] ?? text).trim();
  const variants = (match?.[2] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return { name, variants };
}

function parseBlock(lines: string[]): Block {
  let i = 0;
  if (isDivider(lines[i])) i += 1;

  const rows: string[][] = [];
  while (i < lines.length) {
    const batch: string[] = [];
    while (i < lines.length && isTableLine(lines[i])) {
      batch.push(lines[i]);
      i += 1;
    }
    if (batch.length) {
      const splitLines = batch.map(splitCells);
      const numCols = splitLines[0].length;
      const row: string[] = [];
      for (let c = 0; c < numCols; c += 1) {
        row.push(splitLines.map((cols) => cols[c] ?? '').join('\n').trim());
      }
      rows.push(row);
    }
    if (i < lines.length && isDivider(lines[i])) i += 1;
    else if (batch.length === 0) i += 1;
  }

  const [headerRow, ...dataRows] = rows;
  const { name, variants } = parseHeader(headerRow?.[0] ?? '');
  return { name, variants, rows: dataRows };
}

function splitChunks(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length) chunks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const LINK_REFERENCE_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/gm;

export function parseBlockMarkdown(raw: string): ParsedDocument {
  const linkReferences = new Map<string, string>();
  for (const m of raw.matchAll(LINK_REFERENCE_RE)) {
    linkReferences.set(m[1], m[2]);
  }

  const lines = raw.split('\n');
  const sections: Section[] = [];
  let sectionLines: string[] = [];

  const flushSection = () => {
    const chunks = splitChunks(sectionLines).filter((chunk) => isDivider(chunk[0]));
    sections.push({ blocks: chunks.map(parseBlock) });
    sectionLines = [];
  };

  for (const line of lines) {
    if (line.trim() === '---') flushSection();
    else sectionLines.push(line);
  }
  flushSection();

  return { sections, linkReferences };
}
