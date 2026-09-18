/**
 * DA grid-table Markdown → combined, versioned verb-content JSON. Optional
 * component keys omitted when absent; raw `blocks` + `linkReferences` always present.
 */

import { parseBlockMarkdown } from './gridTable';
import { EXTRACTORS, extractVerb } from './extractors';
import { validateBlocks } from './validate';

/**
 * SemVer of the OUTPUT SHAPE (not content — see `revision`, stamped on commit).
 * 1.2.0 — optional `revision`. 1.1.0 — `blocks` + `linkReferences`. 1.0.0 — howTo/faq.
 */
export const SCHEMA_VERSION = '1.2.0';

export interface ConvertOptions {
  verb: string;
  locale: string;
  validate?: boolean;
}

export interface ConvertResult {
  schemaVersion: string;
  verb: string;
  locale: string;
  warnings: string[];
  data: Record<string, unknown>;
}

export function convert(raw: string, { verb, locale, validate = true }: ConvertOptions): ConvertResult {
  const { sections, linkReferences } = parseBlockMarkdown(raw);
  const blocks = sections.flatMap((s) => s.blocks);
  const warnings: string[] = [];

  const declaredVerb = extractVerb(blocks);
  if (declaredVerb && declaredVerb !== verb) {
    warnings.push(`Rnr block declares verb "${declaredVerb}" but conversion was requested for "${verb}".`);
  }

  if (validate) warnings.push(...validateBlocks(blocks));

  const data: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, verb, locale };

  for (const { key, extract } of EXTRACTORS) {
    const value = extract(blocks, linkReferences);
    if (value !== undefined) data[key] = value;
  }

  data.blocks = sections.flatMap((section, sectionIndex) => section.blocks.map((b) => ({
    section: sectionIndex,
    name: b.name,
    variants: b.variants,
    rows: b.rows,
  })));

  data.linkReferences = Object.fromEntries(linkReferences);

  return { schemaVersion: SCHEMA_VERSION, verb, locale, warnings, data };
}
