/**
 * Markdown → HTML rendering for cell content, using unified/remark/rehype so the
 * consumer can feed the strings straight into `set:html`.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

function withReferences(markdown: string, linkReferences: Map<string, string>): string {
  if (linkReferences.size === 0) return markdown;
  const defs = [...linkReferences.entries()].map(([label, url]) => `[${label}]: ${url}`).join('\n');
  return `${markdown}\n\n${defs}`;
}

/** Inline HTML (paragraph tag unwrapped) — for headings, steps, FAQ questions. */
export function renderInline(markdown: string, linkReferences: Map<string, string>): string {
  const html = String(processor.processSync(withReferences(markdown, linkReferences)));
  const match = html.match(/^<p>([\s\S]*)<\/p>\n?$/);
  return match ? match[1] : html.trim();
}

/** Block-level HTML (keeps <p>/<ul>/…) — for FAQ answers. */
export function renderBlock(markdown: string, linkReferences: Map<string, string>): string {
  return String(processor.processSync(withReferences(markdown, linkReferences))).trim();
}
