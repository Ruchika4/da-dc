#!/usr/bin/env tsx
/**
 * Self-contained batch driver for the "Content export to Astro" workflow.
 * Everything it needs lives under .github/workflows/tools. Reads a config,
 * fetches each source and writes one JSON per verb × locale into the repo,
 * bumping `revision` on change.
 *
 * A source may be:
 *   - DA grid-table Markdown (`.md`) → parsed + grammar-validated via `convert`
 *   - already-shaped JSON (`.json`)  → used as-is (no grammar)
 * detected by the source URL's extension.
 *
 *   tsx .github/workflows/tools/generate.ts --config <cfg> --out-dir . [--urls …] [--locales …] [--strict]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { convert } from './lib/convert';

export interface VerbContentConfig {
  sourceBase: string;
  sourcePathTemplate: string;
  outPathTemplate: string;
  locales: Record<string, string>;
  verbs?: string[];
  entries?: { verb: string; locale: string; sourceUrl?: string; outPath?: string }[];
}

interface Target { verb: string; locale: string; sourceUrl: string; outPath: string; }

function resolveEntry(config: VerbContentConfig, verb: string, locale: string, sourceUrl?: string, outPath?: string): Target {
  const prefix = config.locales?.[locale] ?? '';
  const prefixSeg = prefix ? `/${prefix}` : '';
  const srcPath = config.sourcePathTemplate
    .replaceAll('{localePrefix}', prefixSeg)
    .replaceAll('{verb}', verb)
    .replaceAll('{locale}', locale);
  return {
    verb,
    locale,
    sourceUrl: sourceUrl || `${config.sourceBase}${srcPath}`,
    outPath: outPath || config.outPathTemplate.replaceAll('{verb}', verb).replaceAll('{locale}', locale),
  };
}

/** The locale whose prefix is "" in the map is the default (no path prefix). */
function defaultLocale(locales: Record<string, string> | undefined): string {
  for (const [locale, prefix] of Object.entries(locales ?? {})) {
    if (prefix === '') return locale;
  }
  return Object.keys(locales ?? {})[0] ?? 'en-US';
}

/** Detect locale purely from a URL's path prefix using the config's locale map. */
function detectLocale(url: string, locales: Record<string, string> | undefined): string {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return defaultLocale(locales); }
  for (const [locale, prefix] of Object.entries(locales ?? {})) {
    if (prefix && (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`))) return locale;
  }
  return defaultLocale(locales);
}

/** Strip a known locale prefix from a path, returning the locale-agnostic base path. */
function stripLocalePrefix(pathname: string, locales: Record<string, string> | undefined): string {
  for (const prefix of Object.values(locales ?? {})) {
    if (prefix && (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`))) {
      return pathname.slice(prefix.length + 1); // drop leading "/<prefix>"
    }
  }
  return pathname;
}

/**
 * Expand one full `.md` URL into targets. The URL's locale prefix is stripped to
 * a base path; then, for each locale to generate, the base path is re-prefixed.
 * `localesSel`:
 *   - undefined/'' → just the locale detected from the URL (single file)
 *   - 'all'        → every locale in the config map
 *   - 'de-DE,fr-FR'→ those specific locales
 * This lets an author paste ONE base URL and roll the change out to many locales;
 * locales whose `.md` isn't published simply 404 and are skipped.
 */
function targetsFromUrl(config: VerbContentConfig, url: string, localesSel?: string): Target[] {
  const clean = url.trim();
  let u: URL | undefined;
  try { u = new URL(clean); } catch { /* non-URL, handled below */ }
  const pathname = u ? u.pathname : clean;
  const origin = u ? u.origin : config.sourceBase;
  const basePath = stripLocalePrefix(pathname, config.locales);
  const verb = decodeURIComponent(basePath.split('/').pop() || '').replace(/\.(md|json)$/i, '');

  let locales: string[];
  if (localesSel === 'all') locales = Object.keys(config.locales ?? {});
  else if (localesSel) locales = localesSel.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  else locales = [detectLocale(clean, config.locales)];

  return locales.map((locale) => {
    const prefix = config.locales?.[locale] ?? '';
    const prefixSeg = prefix ? `/${prefix}` : '';
    return {
      verb,
      locale,
      sourceUrl: `${origin}${prefixSeg}${basePath}`,
      outPath: config.outPathTemplate.replaceAll('{verb}', verb).replaceAll('{locale}', locale),
    };
  });
}

/**
 * @param opts.urls    when provided, ad-hoc base `.md` URLs are used INSTEAD of the
 *                     config's verbs × locales.
 * @param opts.locales locale selection for the URLs: '' (locale from URL), 'all'
 *                     (every config locale), or a comma/space list.
 */
export function expandTargets(config: VerbContentConfig, opts: { urls?: string[]; locales?: string } = {}): Target[] {
  if (opts.urls && opts.urls.length) {
    return opts.urls.flatMap((u) => targetsFromUrl(config, u, opts.locales));
  }
  const targets: Target[] = [];
  for (const e of config.entries ?? []) targets.push(resolveEntry(config, e.verb, e.locale, e.sourceUrl, e.outPath));
  if (config.verbs && config.locales) {
    for (const verb of config.verbs) {
      for (const locale of Object.keys(config.locales)) targets.push(resolveEntry(config, verb, locale));
    }
  }
  return targets;
}

export interface RunOptions { rootDir?: string; fetch?: typeof fetch; logger?: Pick<Console, 'log'>; urls?: string[]; locales?: string; }
export interface RunResult { written: string[]; skipped: { outPath: string; reason: string }[]; warnings: string[]; }

export async function run(config: VerbContentConfig, opts: RunOptions = {}): Promise<RunResult> {
  const { rootDir = '.', fetch: fetchImpl = globalThis.fetch, logger = console } = opts;
  const targets = expandTargets(config, { urls: opts.urls, locales: opts.locales });
  const written: string[] = [];
  const skipped: { outPath: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const t of targets) {
    let res: Response;
    try {
      res = await fetchImpl(t.sourceUrl, { cache: 'no-store' });
    } catch (err) {
      skipped.push({ outPath: t.outPath, reason: `fetch error: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!res.ok) { skipped.push({ outPath: t.outPath, reason: `source ${res.status} ${t.sourceUrl}` }); continue; }
    const raw = await res.text();

    // Source may be DA grid-table Markdown (.md → convert + grammar) or already
    // shaped JSON (.json → use as-is, no grammar). Detected by the URL extension.
    let data: Record<string, unknown>;
    if (/\.json(\?|#|$)/i.test(t.sourceUrl)) {
      try { data = JSON.parse(raw); } catch { skipped.push({ outPath: t.outPath, reason: `invalid JSON source ${t.sourceUrl}` }); continue; }
      delete (data as { revision?: unknown }).revision; // revision is managed here, not taken from the source
    } else {
      const converted = convert(raw, { verb: t.verb, locale: t.locale });
      data = converted.data;
      for (const one of converted.warnings) warnings.push(`${t.verb}/${t.locale}: ${one}`);
    }

    const full = path.join(rootDir, t.outPath);
    let revision = 1;
    let existing: Record<string, unknown> | undefined;
    try { existing = JSON.parse(await fs.readFile(full, 'utf-8')); } catch { /* new file */ }
    if (existing) {
      const { revision: prevRev, ...prevBody } = existing;
      if (JSON.stringify(prevBody) === JSON.stringify(data)) { skipped.push({ outPath: t.outPath, reason: 'unchanged' }); continue; }
      revision = (Number.isInteger(prevRev) ? (prevRev as number) : 0) + 1;
    }

    const { schemaVersion, ...body } = data;
    const out = { schemaVersion, revision, ...body };
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
    written.push(`${t.outPath} (r${revision})`);
  }

  logger.log(`Generated ${written.length} file(s); skipped ${skipped.length}.`);
  written.forEach((f) => logger.log(`  wrote  ${f}`));
  skipped.forEach((s) => logger.log(`  skip   ${s.outPath} — ${s.reason}`));
  warnings.forEach((w) => logger.log(`  warn   ${w}`));
  return { written, skipped, warnings };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = { config: 'verb-content.config.json', outDir: '.', strict: false, urls: '', locales: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') opts.config = argv[(i += 1)];
    else if (argv[i] === '--out-dir') opts.outDir = argv[(i += 1)];
    else if (argv[i] === '--urls') opts.urls = argv[(i += 1)];
    else if (argv[i] === '--locales') opts.locales = argv[(i += 1)];
    else if (argv[i] === '--strict') opts.strict = true;
  }
  const config = JSON.parse(await fs.readFile(opts.config, 'utf-8')) as VerbContentConfig;
  // Ad-hoc base URLs (comma/space/newline separated) override the config's verbs ×
  // locales. `--locales` selects which locales to generate for those URLs: empty =
  // locale from the URL prefix, 'all' = every config locale, or a comma list.
  const urls = opts.urls.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
  const { warnings } = await run(config, {
    rootDir: opts.outDir,
    urls: urls.length ? urls : undefined,
    locales: opts.locales || undefined,
  });
  if (opts.strict && warnings.length) {
    process.stderr.write(`error: --strict: ${warnings.length} grammar warning(s)\n`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
