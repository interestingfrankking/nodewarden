#!/usr/bin/env node
/**
 * Build an account-scoped Wrangler config for GitHub Actions deployments.
 *
 * The repository ships `wrangler.toml` / `wrangler.kv.toml` without
 * account-scoped identifiers (`database_id`, KV namespace `id`): Cloudflare's
 * Git integration fills those in at build time. A GitHub Actions deployment has
 * to inject them explicitly, so this script copies the checked-in config and:
 *
 *   - renames the Worker (`NW_WORKER_NAME`)
 *   - pins the D1 database id and name (`NW_D1_DATABASE_ID`, `NW_D1_DATABASE_NAME`)
 *   - pins the R2 bucket name (`NW_R2_BUCKET_NAME`) when the config has an
 *     `ATTACHMENTS` R2 binding, or the KV namespace id (`NW_KV_NAMESPACE_ID`)
 *     when the config has an `ATTACHMENTS_KV` binding
 *   - drops `[build]`, because the workflow already ran `npm run build`
 *   - optionally attaches a custom domain (`NW_CUSTOM_DOMAIN`) and plain-text
 *     Worker variables (`NW_VARS_JSON`, a JSON object of string values)
 *
 * Everything is validated before the file is written, so a typo fails the
 * workflow before Wrangler touches the Cloudflare account. The script is pure
 * (no network, no shell) and safe to run locally:
 *
 *   NW_D1_DATABASE_ID=... NW_R2_BUCKET_NAME=... node .github/scripts/prepare-wrangler-config.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID_RE = /^[0-9a-f]{32}$/i;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LOG_PREFIX = '[prepare-wrangler-config]';

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function die(message) {
  console.error(`${LOG_PREFIX} error: ${message}`);
  process.exit(1);
}

/** TOML basic string. JSON escaping is a valid subset for our values. */
function tomlString(value) {
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

/**
 * Minimal TOML splitter: splits a Wrangler config into the root block and a
 * list of `[table]` / `[[table-array]]` blocks, preserving comments and order.
 * We only need to rewrite scalar keys inside known blocks, never to re-serialize
 * the whole document.
 */
function splitConfig(text) {
  const root = { raw: null, name: null, lines: [] };
  const sections = [];
  let current = root;

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const header = /^\s*(\[\[?)\s*([A-Za-z0-9_.-]+)\s*(\]\]?)\s*$/.exec(line);
    if (!header) {
      current.lines.push(line);
      continue;
    }
    current = { raw: line.trim(), name: header[2], lines: [] };
    sections.push(current);
  }

  return { root, sections };
}

function renderConfig({ root, sections }) {
  const parts = [];
  const rootBody = trimBlankLines(root.lines).join('\n');
  if (rootBody) parts.push(rootBody);

  for (const section of sections) {
    const body = trimBlankLines(section.lines).join('\n');
    parts.push(body ? `${section.raw}\n${body}` : section.raw);
  }

  return `${parts.join('\n\n')}\n`;
}

function lastContentIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== '') return index;
  }
  return -1;
}

/** Set a scalar key inside a block, replacing an existing assignment in place. */
function setKey(section, key, literal) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const index = section.lines.findIndex((line) => pattern.test(line));

  if (index !== -1) {
    section.lines[index] = `${key} = ${literal}`;
    return;
  }

  const insertAt = lastContentIndex(section.lines) + 1;
  section.lines.splice(insertAt, 0, `${key} = ${literal}`);
}

function readKey(section, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`);
  for (const line of section.lines) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** Find the block for a binding name, tolerating configs with extra bindings. */
function findBindingSection(sections, table, binding) {
  const candidates = sections.filter((section) => section.name === table);
  if (candidates.length === 0) return null;

  const exact = candidates.find((section) => readKey(section, 'binding') === binding);
  if (exact) return exact;

  if (candidates.length === 1 && readKey(candidates[0], 'binding') === null) {
    return candidates[0];
  }

  return null;
}

function optional(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function parseVars(raw) {
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    die(`NW_VARS_JSON is not valid JSON (${error.message})`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die('NW_VARS_JSON must be a JSON object, e.g. {"HIDE_WEB_VAULT":"1"}');
  }

  const entries = Object.entries(parsed).map(([key, value]) => {
    if (!VAR_KEY_RE.test(key)) {
      die(`NW_VARS_JSON key "${key}" is not a valid Worker variable name`);
    }
    if (value === null || typeof value === 'object') {
      die(`NW_VARS_JSON value for "${key}" must be a string, number, or boolean`);
    }
    return [key, String(value)];
  });

  return entries.length > 0 ? entries : null;
}

function main() {
  const configPath = resolve(optional('NW_CONFIG') || 'wrangler.toml');
  const outputPath = resolve(optional('NW_OUTPUT') || 'wrangler.ci.toml');

  if (configPath === outputPath) {
    die('NW_OUTPUT must differ from NW_CONFIG: the checked-in Wrangler config is never modified');
  }
  const workerName = optional('NW_WORKER_NAME') || 'nodewarden';
  const d1Name = optional('NW_D1_DATABASE_NAME') || 'nodewarden-db';
  const d1Id = optional('NW_D1_DATABASE_ID');
  const r2Bucket = optional('NW_R2_BUCKET_NAME');
  const kvId = optional('NW_KV_NAMESPACE_ID');
  const customDomain = optional('NW_CUSTOM_DOMAIN').toLowerCase();
  const vars = parseVars(optional('NW_VARS_JSON'));

  if (!WORKER_NAME_RE.test(workerName)) {
    die(
      `worker name "${workerName}" is invalid: use 1-63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit`
    );
  }
  if (!d1Id) {
    die('NW_D1_DATABASE_ID is required (run `npx wrangler d1 list --json` to find it)');
  }
  if (!UUID_RE.test(d1Id)) {
    die(`NW_D1_DATABASE_ID "${d1Id}" is not a D1 database UUID`);
  }
  if (customDomain && !DOMAIN_RE.test(customDomain)) {
    die(`NW_CUSTOM_DOMAIN "${customDomain}" is not a valid hostname, e.g. vault.example.com`);
  }

  let config;
  try {
    config = splitConfig(readFileSync(configPath, 'utf8'));
  } catch (error) {
    die(`cannot read ${configPath}: ${error.message}`);
  }

  const { root, sections } = config;

  // The workflow builds the web vault itself; letting Wrangler run [build] again
  // would double the build time and can mask a stale dist/ directory.
  const buildSections = sections.filter((section) => section.name === 'build');
  if (buildSections.length > 0) {
    for (const section of buildSections) sections.splice(sections.indexOf(section), 1);
    log('removed [build] (the workflow already ran `npm run build`)');
  }

  setKey(root, 'name', tomlString(workerName));

  const d1 = findBindingSection(sections, 'd1_databases', 'DB');
  if (!d1) die(`${configPath} has no [[d1_databases]] block bound to DB`);
  setKey(d1, 'database_name', tomlString(d1Name));
  setKey(d1, 'database_id', tomlString(d1Id));

  const r2 = findBindingSection(sections, 'r2_buckets', 'ATTACHMENTS');
  if (r2) {
    if (!r2Bucket) die('this config uses R2 attachments, so NW_R2_BUCKET_NAME is required');
    if (!BUCKET_RE.test(r2Bucket)) {
      die(
        `R2 bucket name "${r2Bucket}" is invalid: use 3-63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit`
      );
    }
    setKey(r2, 'bucket_name', tomlString(r2Bucket));
    log(`R2 bucket: ${r2Bucket}`);
  }

  const kv = findBindingSection(sections, 'kv_namespaces', 'ATTACHMENTS_KV');
  if (kv) {
    if (!kvId) die('this config uses KV attachments, so NW_KV_NAMESPACE_ID is required');
    if (!KV_ID_RE.test(kvId)) die(`NW_KV_NAMESPACE_ID "${kvId}" is not a 32-character KV namespace id`);
    setKey(kv, 'id', tomlString(kvId));
    log(`KV namespace id: ${kvId}`);
  }

  if (!r2 && !kv) {
    die(`${configPath} has neither an ATTACHMENTS R2 binding nor an ATTACHMENTS_KV binding`);
  }

  if (customDomain) {
    setKey(root, 'routes', `[{ pattern = ${tomlString(customDomain)}, custom_domain = true }]`);
    log(`custom domain: ${customDomain}`);
  }

  if (vars) {
    const existing = sections.find((section) => section.name === 'vars');
    if (existing) {
      for (const [key, value] of vars) setKey(existing, key, tomlString(value));
    } else {
      sections.push({
        raw: '[vars]',
        name: 'vars',
        lines: vars.map(([key, value]) => `${key} = ${tomlString(value)}`),
      });
    }
    log(`vars: ${vars.map(([key]) => key).join(', ')}`);
  }

  const output = renderConfig(config);

  // Guard rails: fail loudly rather than deploys a half-configured Worker.
  const checks = [
    [new RegExp(`^name = ${escapeRegExp(tomlString(workerName))}$`, 'm'), 'worker name'],
    [new RegExp(`^database_id = ${escapeRegExp(tomlString(d1Id))}$`, 'm'), 'D1 database id'],
    [/^\[build\]/m, 'unexpected [build] block', true],
  ];
  for (const [pattern, label, mustBeAbsent] of checks) {
    const found = pattern.test(output);
    if (mustBeAbsent && found) die(`generated config still contains ${label}`);
    if (!mustBeAbsent && !found) die(`generated config is missing ${label}`);
  }

  writeFileSync(outputPath, output, 'utf8');
  log(`wrote ${outputPath} for worker "${workerName}" (D1 ${d1Name})`);
}

main();
