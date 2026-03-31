'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client    = new Anthropic();

const COMPLEX_SIGNALS = [
  'and then','after that','followed by','multiple','several',
  'merge and','full pipeline','architecture','refactor',
  'folatac','gcg','legal','financial','strategy',
];

function selectPlannerModel(instruction) {
  const lower = instruction.toLowerCase();
  if (COMPLEX_SIGNALS.some(s => lower.includes(s))) return 'claude-sonnet-4-6';
  if (instruction.length > 200)                     return 'claude-sonnet-4-6';
  return 'claude-haiku-4-5-20251001';
}

function makePlannerSystem() {
  const suffix = Math.random().toString(36).slice(2, 6);

  const CAPABILITIES = `STEP TYPES (use only these):
github_read_file         {path, ref?}                                     → {content, sha}
github_create_branch     {branch, from?}                                  → {branch}
github_write_file        {path, branch, message,
                          __from_step_index: N, __field: "content"}       → commit
  RULE: NEVER inline content. Always chain from a compute step.
github_open_pr           {branch, title, body, base?}                     → {url, number}
github_merge_pr          {__from_step_index: N, __field: "number"}        → {merged}
  RULE: Get number from open_pr step. Never use a literal number.
compute                  {fn, inputs: {"file": N}}                        → varies
  N = 0-based step index. fns: apply_routing_patch, apply_indicator_patch,
  apply_text_patch, run_syntax_check
vercel_deploy            {environment?}                                    → {deployment_id, url}
vercel_check_deploy      {__from_step_index: N, __field: "deployment_id"} → {status, url}
memory_set               {category, field, value}
notify_anthony           {message}
require_anthony_approval {question, options:[]}                            → PAUSES

ORDERING: read → branch → compute(patch) → compute(syntax_check) → write → open_pr
write: __from_step_index = patch step, __field = "content"
merge: __from_step_index = open_pr step, __field = "number"
max 20 steps. Branch: demis/[descriptor]-[4 random chars]. PR body < 400 chars.`;

  return `Convert the instruction into a JSON step plan. Return ONLY valid JSON. No preamble, no markdown.

${CAPABILITIES}

Example — suffix is random, do NOT copy "${suffix}":
{
  "taskLabel": "Fix model routing",
  "branch": "demis/routing-${suffix}",
  "prTitle": "fix: narrow model routing",
  "prBody": "Narrows SONNET_TRIGGERS. Default Haiku.",
  "steps": [
    {"label":"Read _utils.js",  "fn":"github_read_file",     "args":{"path":"src/api/_utils.js"}},
    {"label":"Create branch",   "fn":"github_create_branch", "args":{"branch":"demis/routing-${suffix}"}},
    {"label":"Patch _utils.js", "fn":"compute",              "args":{"fn":"apply_routing_patch","inputs":{"file":0}}},
    {"label":"Syntax check",    "fn":"compute",              "args":{"fn":"run_syntax_check","inputs":{"file":2}}},
    {"label":"Write _utils.js", "fn":"github_write_file",    "args":{"path":"src/api/_utils.js","branch":"demis/routing-${suffix}","message":"fix: routing","__from_step_index":2,"__field":"content"}},
    {"label":"Open PR",         "fn":"github_open_pr",       "args":{"branch":"demis/routing-${suffix}","title":"fix: routing","body":"Narrows keywords."}},
    {"label":"Merge PR",        "fn":"github_merge_pr",      "args":{"__from_step_index":5,"__field":"number"}}
  ],
  "canExecute": true,
  "blockers": []
}

Failure: {"canExecute": false, "blockers": ["reason"], "clarifyingQuestion": "one question"}`;
}

async function plan(instruction, memoryContext = null) {
  const model   = selectPlannerModel(instruction);
  const system  = makePlannerSystem();
  const content = memoryContext
    ? `CONTEXT:\n${memoryContext}\n\nINSTRUCTION: ${instruction}`
    : `INSTRUCTION: ${instruction}`;

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content }],
  });

  const text  = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`Planner JSON parse failed: ${e.message} | Raw: ${clean.slice(0, 200)}`);
  }
}

const KNOWN_FNS = new Set([
  'github_read_file', 'github_create_branch', 'github_write_file',
  'github_open_pr',   'github_merge_pr',       'compute',
  'vercel_deploy',    'vercel_check_deploy',
  'memory_set',       'notify_anthony',         'require_anthony_approval',
]);

function validatePlan(p) {
  const errors = [];
  if (!p.taskLabel)             errors.push('missing taskLabel');
  if (!Array.isArray(p.steps))  errors.push('steps must be an array');
  if (!p.steps?.length)         errors.push('steps must not be empty');
  if (p.steps?.length > 20)     errors.push('steps must not exceed 20');
  for (const s of (p.steps || [])) {
    if (!KNOWN_FNS.has(s.fn))  errors.push(`unknown fn: "${s.fn}"`);
    if (!s.label)              errors.push('step missing label');
    if (s.args == null)        errors.push(`step "${s.label}" missing args`);
  }
  return errors;
}

module.exports = { plan, validatePlan, selectPlannerModel };
