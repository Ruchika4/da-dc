/**
 * Grammar validation: warn for blocks/variants/metadata outside the enum surface.
 * Warnings only (blocks still emitted). Case- and hyphen/space-insensitive.
 */

import type { Block } from './gridTable';
import { BLOCK_GRAMMAR, SECTION_METADATA } from './extractors';

const clean = (s: string | undefined): string => (s ?? '').replace(/\*\*/g, '').replace(/\\/g, '').trim();
const norm = (s: string | undefined): string => clean(s).toLowerCase().replace(/[-\s]+/g, ' ').trim();

const BY_NAME = new Map(BLOCK_GRAMMAR.map((b) => [b.name, b]));
const STYLE_TOKENS = new Set(SECTION_METADATA.styleTokens.map(norm));
const BACKGROUNDS = new Set(SECTION_METADATA.backgrounds.map(norm));
const META_KEYS = new Set(SECTION_METADATA.keys.map((k) => k.toLowerCase()));

function validateSectionMetadata(block: Block): string[] {
  const warnings: string[] = [];
  for (const row of block.rows) {
    const key = clean(row[0]).toLowerCase();
    const value = clean(row[1]);
    if (!key) continue;
    if (!META_KEYS.has(key)) {
      warnings.push(`Section Metadata: unknown key "${key}" (known: ${SECTION_METADATA.keys.join(', ')}).`);
      continue;
    }
    if (!value) continue;
    if (key === 'style') {
      for (const token of value.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)) {
        if (!STYLE_TOKENS.has(norm(token))) {
          warnings.push(`Section Metadata style token "${token}" is not in the grammar (known: ${SECTION_METADATA.styleTokens.join(', ')}).`);
        }
      }
    } else if (key === 'background' && !BACKGROUNDS.has(norm(value))) {
      warnings.push(`Section Metadata background "${value}" is not in the grammar (known: ${SECTION_METADATA.backgrounds.join(', ')}).`);
    }
  }
  return warnings;
}

export function validateBlocks(blocks: Block[]): string[] {
  const warnings: string[] = [];
  for (const block of blocks) {
    const grammar = BY_NAME.get(block.name);
    if (!grammar) {
      warnings.push(`Unknown block type "${block.name}" — not in the authoring grammar (grammar.json).`);
      continue;
    }
    const known = new Set(grammar.variants.map(norm));
    for (const variant of block.variants) {
      if (!known.has(norm(variant))) {
        warnings.push(`Unknown variant "${variant}" on "${block.name}" block (known: ${grammar.variants.join(', ') || 'none'}).`);
      }
    }
    if (block.name === 'Section Metadata') warnings.push(...validateSectionMetadata(block));
  }
  return [...new Set(warnings)];
}
