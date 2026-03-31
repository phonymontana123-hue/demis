'use strict';

const { kv } = require('@vercel/kv');

const KEY = 'demis:memory';
const TTL = 60 * 60 * 24 * 365 * 2;

const VALID_CATEGORIES = new Set(['preferences', 'rules', 'failures', 'decisions']);

function emptyMemory() {
  return { preferences:{}, rules:{}, failures:{}, decisions:{} };
}

async function readAll() {
  return (await kv.get(KEY)) || emptyMemory();
}

async function set(category, field, value) {
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(
      `Unknown memory category: "${category}". Valid: ${[...VALID_CATEGORIES].join(', ')}`
    );
  }
  const mem = await readAll();
  if (!mem[category]) mem[category] = {};
  mem[category][field] = { value, set_at: new Date().toISOString() };
  await kv.set(KEY, mem, { ex: TTL });
  return mem[category][field];
}

async function remove(category, field) {
  const mem = await readAll();
  if (mem[category]) delete mem[category][field];
  await kv.set(KEY, mem, { ex: TTL });
}

async function removeAny(field) {
  const mem = await readAll();
  let removed = false;
  for (const cat of VALID_CATEGORIES) {
    if (mem[cat] && mem[cat][field]) {
      delete mem[cat][field];
      removed = true;
    }
  }
  if (removed) await kv.set(KEY, mem, { ex: TTL });
  return removed;
}

function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function parseMemoryInstruction(text) {
  const lower = text.toLowerCase().trim();
  const orig  = text.trim();

  const rememberM = lower.match(/^remember (that )?/);
  if (rememberM) {
    const value = orig.slice(rememberM[0].length).trim();
    return { action:'set', category:'preferences', field:`p_${stableHash(value.toLowerCase())}`, value };
  }

  const ruleM = lower.match(/^(standing rule|always|never)[:\s]+/);
  if (ruleM) {
    const value = orig.slice(ruleM[0].length).trim();
    return { action:'set', category:'rules', field:`r_${stableHash(value.toLowerCase())}`, value };
  }

  const decideM = lower.match(/^(decide that |decision[:\s]+|decided[:\s]+)/);
  if (decideM) {
    const value = orig.slice(decideM[0].length).trim();
    return { action:'set', category:'decisions', field:`d_${stableHash(value.toLowerCase())}`, value };
  }

  const failureM = lower.match(/^(note|mark|flag) (that )?(.+?) (is broken|failed|doesn't work)/);
  if (failureM) {
    const prefixLen = failureM[1].length + (failureM[2]?.length || 0);
    let field = orig.slice(prefixLen).trim();
    for (const suffix of ['is broken', 'failed', "doesn't work"]) {
      const idx = field.toLowerCase().lastIndexOf(suffix);
      if (idx !== -1) { field = field.slice(0, idx).trim(); break; }
    }
    return { action:'set', category:'failures', field, value:'known_failure' };
  }

  const forgetM = lower.match(/^(forget|clear|remove) /);
  if (forgetM) {
    return { action:'remove', category:null, field: orig.slice(forgetM[0].length).trim() };
  }

  return null;
}

function formatForPrompt(mem) {
  const lines = [];

  const prefs = Object.values(mem.preferences || {});
  if (prefs.length) {
    lines.push('STANDING PREFERENCES:');
    prefs.forEach(e => lines.push(`  - ${e.value}`));
  }

  const rules = Object.values(mem.rules || {});
  if (rules.length) {
    lines.push('STANDING RULES:');
    rules.forEach(e => lines.push(`  - ${e.value}`));
  }

  const failures = Object.keys(mem.failures || {});
  if (failures.length) {
    lines.push('KNOWN FAILURES (do not use):');
    failures.forEach(f => lines.push(`  - ${f}`));
  }

  const decisions = Object.values(mem.decisions || {});
  if (decisions.length) {
    lines.push('PAST DECISIONS (apply to recurring situations):');
    decisions.forEach(e => lines.push(`  - ${e.value}`));
  }

  return lines.length ? lines.join('\n') : null;
}

module.exports = {
  readAll, set, remove, removeAny,
  parseMemoryInstruction, formatForPrompt,
  VALID_CATEGORIES,
};
