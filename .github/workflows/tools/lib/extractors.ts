/**
 * Semantic extractors (DA blocks → verb-content keys) plus the authoring grammar
 * (block types, variant enums, Section Metadata enums). The grammar is the
 * canonical source for grammar.json.
 */

import type { Block } from './gridTable';
import { renderInline, renderBlock } from './markdown';

export interface HowToVideo {
  title: string;
  fragmentUrl?: string;
  posterUrl?: string;
}

export interface HowToContent {
  heading: string;
  intro: string[];
  steps: string[];
  video?: HowToVideo;
}

export interface FaqContent {
  items: { q: string; a: string }[];
}

export interface BlockGrammar {
  name: string;
  variants: string[];
  mapsTo: string | null;
  notes: string;
}

export interface SectionMetadataGrammar {
  keys: string[];
  styleTokens: string[];
  backgrounds: string[];
}

export const BLOCK_GRAMMAR: BlockGrammar[] = [
  { name: 'How To', variants: ['large image', 'large media', 'seo', 'container', 'xlarge'], mapsTo: 'howTo', notes: 'Row 0 = heading + intro + optional video line; row 1 = "-" bulleted steps.' },
  { name: 'Accordion', variants: ['verb subfooter mobile', 'seo'], mapsTo: 'faq', notes: 'Only the UN-varianted Accordion becomes `faq` (alternating Q/A rows). Varianted ones are ignored by the faq extractor.' },
  { name: 'Rnr', variants: [], mapsTo: null, notes: 'The `Verb` row declares the verb id; cross-check only.' },
  { name: 'Section Metadata', variants: [], mapsTo: null, notes: 'Per-section styling; see `sectionMetadata` enums.' },
  { name: 'Text', variants: ['l body', 'xs body', 'medium', 'large', 'center', 'contained', 'l spacing top', 'l spacing bottom', 's spacing', 's spacing top', 'xl spacing', 'xl spacing top', 'xs spacing bottom'], mapsTo: null, notes: 'Marketing copy / section headings. Raw `blocks[]` only.' },
  { name: 'Icon Block', variants: ['vertical', 'small', 'center', 'xs spacing'], mapsTo: null, notes: 'SEO feature card. Raw `blocks[]` only.' },
  { name: 'Media', variants: ['large'], mapsTo: null, notes: 'Image + copy + CTA links. Raw `blocks[]` only.' },
  { name: 'Columns', variants: ['verb subfooter', 'container'], mapsTo: null, notes: 'Related-tools footer grid. Raw `blocks[]` only.' },
  { name: 'Breadcrumbs', variants: [], mapsTo: null, notes: 'Breadcrumb navigation. Raw `blocks[]` only.' },
  { name: 'Editorial Card', variants: ['no border', 'xs body', 'xs heading'], mapsTo: null, notes: 'Editorial/promo card. Raw `blocks[]` only.' },
  { name: 'Metadata', variants: [], mapsTo: null, notes: 'Page-level metadata. Raw `blocks[]` only.' },
  { name: 'Unity', variants: ['workflow acrobat'], mapsTo: null, notes: 'Unity SDK / verb bridge. Raw `blocks[]` only.' },
  { name: 'Verb Widget', variants: ['combine pdf', 'compress pdf', 'crop pages', 'jpg to pdf', 'pdf to image', 'pdf to word', 'rotate pages', 'split pdf'], mapsTo: null, notes: 'Lightweight verb widget; variant selects the verb. Raw `blocks[]` only.' },
];

export const KNOWN_BLOCK_TYPES: string[] = BLOCK_GRAMMAR.map((b) => b.name);

export const SECTION_METADATA: SectionMetadataGrammar = {
  keys: ['style', 'background'],
  styleTokens: ['l spacing', 'l spacing top', 's spacing', 'xl spacing', 'xs spacing', 'xxl spacing', 'xxl spacing bottom', 'divider', 'center', 'three up', 'four up', 'grid width 10'],
  backgrounds: ['white', '#fbfbfb', '#f8f8f8', '#fff'],
};

const VIDEO_IMAGE_RE = /^!\[([^\]]*)\]\[([^\]]+)\]$/;

function parseVideoLine(line: string, linkReferences: Map<string, string>): HowToVideo | undefined {
  const match = line.match(VIDEO_IMAGE_RE);
  if (!match) return undefined;
  const [, altText, label] = match;
  const [fragmentUrl, title] = altText.split(/\s*\\\|\s*/);
  if (!fragmentUrl) return undefined;
  return { title: (title ?? '').trim(), fragmentUrl: fragmentUrl.trim(), posterUrl: linkReferences.get(label) };
}

export function extractHowTo(blocks: Block[], linkReferences: Map<string, string>): HowToContent | undefined {
  const block = blocks.find((b) => b.name === 'How To');
  if (!block || block.rows.length === 0) return undefined;

  const introCell = block.rows[0]?.[0] ?? '';
  let heading = '';
  const intro: string[] = [];
  let video: HowToVideo | undefined;

  for (const line of introCell.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      heading = renderInline(trimmed.replace(/^#+\s*/, ''), linkReferences);
      continue;
    }
    const parsedVideo = parseVideoLine(trimmed, linkReferences);
    if (parsedVideo) {
      video = parsedVideo;
      continue;
    }
    intro.push(renderInline(trimmed, linkReferences));
  }

  const stepsCell = block.rows[1]?.[0] ?? '';
  const steps = stepsCell
    .split('\n')
    .filter((line) => line.trim().startsWith('-'))
    .map((line) => renderInline(line.trim().replace(/^-\s*/, ''), linkReferences));

  const howTo: HowToContent = { heading, intro, steps };
  if (video) howTo.video = video;
  return howTo;
}

export function extractFaq(blocks: Block[], linkReferences: Map<string, string>): FaqContent | undefined {
  const block = blocks.find((b) => b.name === 'Accordion' && b.variants.length === 0);
  if (!block) return undefined;

  const items: FaqContent['items'] = [];
  for (let i = 0; i + 1 < block.rows.length; i += 2) {
    const q = block.rows[i]?.[0];
    const a = block.rows[i + 1]?.[0];
    if (!q || !a) continue;
    items.push({ q: renderInline(q, linkReferences), a: renderBlock(a, linkReferences) });
  }
  return items.length ? { items } : undefined;
}

export function extractVerb(blocks: Block[]): string | undefined {
  const block = blocks.find((b) => b.name === 'Rnr');
  const row = block?.rows.find((r) => r[0]?.toLowerCase() === 'verb');
  return row?.[1];
}

export interface Extractor {
  key: string;
  extract: (blocks: Block[], refs: Map<string, string>) => unknown;
}

export const EXTRACTORS: Extractor[] = [
  { key: 'howTo', extract: (blocks, refs) => extractHowTo(blocks, refs) },
  { key: 'faq', extract: (blocks, refs) => extractFaq(blocks, refs) },
];
