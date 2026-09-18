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

export function expandTargets(config: VerbContentConfig): Target[] {
  const targets: Target[] = [];
  for (const e of config.entries ?? []) targets.push(resolveEntry(config, e.verb, e.locale, e.mdUrl, e.outPath));
  if (config.verbs && config.locales) {
    for (const verb of config.verbs) {
      for (const locale of Object.keys(config.locales)) targets.push(resolveEntry(config, verb, locale));
    }
  }
  return targets;
}

export interface RunOptions { rootDir?: string; fetch?: typeof fetch; logger?: Pick<Console, 'log'>; }
export interface RunResult { written: string[]; skipped: { outPath: string; reason: string }[]; warnings: string[]; }

export async function run(config: VerbContentConfig, opts: RunOptions = {}): Promise<RunResult> {
  const { rootDir = '.', fetch: fetchImpl = globalThis.fetch, logger = console } = opts;
  const targets = expandTargets(config);
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
  const opts = { config: 'verb-content.config.json', outDir: '.', strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') opts.config = argv[(i += 1)];
    else if (argv[i] === '--out-dir') opts.outDir = argv[(i += 1)];
    else if (argv[i] === '--strict') opts.strict = true;
  }
  const config = JSON.parse(await fs.readFile(opts.config, 'utf-8')) as VerbContentConfig;
  const { warnings } = await run(config, { rootDir: opts.outDir });
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
