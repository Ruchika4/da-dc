#!/usr/bin/env tsx
/**
 * Self-contained batch driver for the verb-content-pr workflow. Everything it
 * needs lives under .github/workflows/tools. Reads a config, generates one JSON
 * per verb × locale (fetch each locale's published `.md`, convert), writes into
 * the repo, and bumps `revision`.
 *
 *   tsx .github/workflows/tools/generate.ts --config <cfg> --out-dir . [--strict]
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
  entries?: { verb: string; locale: string; mdUrl?: string; outPath?: string }[];
}

interface Target { verb: string; locale: string; mdUrl: string; outPath: string; }

function resolveEntry(config: VerbContentConfig, verb: string, locale: string, mdUrl?: string, outPath?: string): Target {
  const prefix = config.locales?.[locale] ?? '';
  const prefixSeg = prefix ? `/${prefix}` : '';
  const srcPath = config.sourcePathTemplate
    .replaceAll('{localePrefix}', prefixSeg)
    .replaceAll('{verb}', verb)
    .replaceAll('{locale}', locale);
  return {
    verb,
    locale,
    mdUrl: mdUrl || `${config.sourceBase}${srcPath}`,
    outPath: outPath || config.outPathTemplate.replaceAll('{verb}', verb).replaceAll('{locale}', locale),
  };
}

/** Detect locale from a URL's path prefix using the config's locale map, else fall back. */
function detectLocale(url: string, locales: Record<string, string> | undefined, fallback: string): string {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return fallback; }
  for (const [locale, prefix] of Object.entries(locales ?? {})) {
    if (prefix && (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`))) return locale;
  }
  return fallback;
}

/** Build a target from a full `.md` URL: verb from the filename, locale from the path (or fallback). */
function targetFromUrl(config: VerbContentConfig, url: string, fallbackLocale: string): Target {
  const clean = url.trim();
  let pathname = clean;
  try { pathname = new URL(clean).pathname; } catch { /* keep as-is */ }
  const verb = decodeURIComponent(pathname.split('/').pop() || '').replace(/\.md$/i, '');
  const locale = detectLocale(clean, config.locales, fallbackLocale);
  return {
    verb,
    locale,
    mdUrl: clean,
    outPath: config.outPathTemplate.replaceAll('{verb}', verb).replaceAll('{locale}', locale),
  };
}

/**
 * @param opts.urls  when provided, ad-hoc full `.md` URLs are used INSTEAD of the
 *                   config's verbs × locales (verb from filename, locale from path
 *                   prefix or `fallbackLocale`).
 */
export function expandTargets(config: VerbContentConfig, opts: { urls?: string[]; fallbackLocale?: string } = {}): Target[] {
  const fallbackLocale = opts.fallbackLocale ?? 'en-US';
  if (opts.urls && opts.urls.length) {
    return opts.urls.map((u) => targetFromUrl(config, u, fallbackLocale));
  }
  const targets: Target[] = [];
  for (const e of config.entries ?? []) targets.push(resolveEntry(config, e.verb, e.locale, e.mdUrl, e.outPath));
  if (config.verbs && config.locales) {
    for (const verb of config.verbs) {
      for (const locale of Object.keys(config.locales)) targets.push(resolveEntry(config, verb, locale));
    }
  }
  return targets;
}

export interface RunOptions { rootDir?: string; fetch?: typeof fetch; logger?: Pick<Console, 'log'>; urls?: string[]; fallbackLocale?: string; }
export interface RunResult { written: string[]; skipped: { outPath: string; reason: string }[]; warnings: string[]; }

export async function run(config: VerbContentConfig, opts: RunOptions = {}): Promise<RunResult> {
  const { rootDir = '.', fetch: fetchImpl = globalThis.fetch, logger = console } = opts;
  const targets = expandTargets(config, { urls: opts.urls, fallbackLocale: opts.fallbackLocale });
  const written: string[] = [];
  const skipped: { outPath: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const t of targets) {
    let res: Response;
    try {
      res = await fetchImpl(t.mdUrl, { cache: 'no-store' });
    } catch (err) {
      skipped.push({ outPath: t.outPath, reason: `fetch error: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!res.ok) { skipped.push({ outPath: t.outPath, reason: `source ${res.status} ${t.mdUrl}` }); continue; }
    const raw = await res.text();
    const { data, warnings: w } = convert(raw, { verb: t.verb, locale: t.locale });
    for (const one of w) warnings.push(`${t.verb}/${t.locale}: ${one}`);

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
  const opts = { config: 'verb-content.config.json', outDir: '.', strict: false, urls: '', locale: 'en-US' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') opts.config = argv[(i += 1)];
    else if (argv[i] === '--out-dir') opts.outDir = argv[(i += 1)];
    else if (argv[i] === '--urls') opts.urls = argv[(i += 1)];
    else if (argv[i] === '--locale') opts.locale = argv[(i += 1)];
    else if (argv[i] === '--strict') opts.strict = true;
  }
  const config = JSON.parse(await fs.readFile(opts.config, 'utf-8')) as VerbContentConfig;
  // Ad-hoc URLs (comma/space/newline separated) override the config's verbs × locales.
  const urls = opts.urls.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
  const { warnings } = await run(config, {
    rootDir: opts.outDir,
    urls: urls.length ? urls : undefined,
    fallbackLocale: opts.locale,
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
