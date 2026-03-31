'use strict';

process.env.KV_REST_API_URL   = 'http://localhost';
process.env.KV_REST_API_TOKEN = 'test-token';

const path = require('path');

const kvStore = {};
const Module  = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(req, ...args) {
  if (req === '@vercel/kv') return '@vercel/kv';
  return origResolve.call(this, req, ...args);
};
require.cache['@vercel/kv'] = {
  id: '@vercel/kv', filename: '@vercel/kv', loaded: true,
  exports: {
    kv: {
      get: async (k)    => kvStore[k] ?? null,
      set: async (k, v) => { kvStore[k] = v; return true; },
      del: async (k)    => { delete kvStore[k]; return true; },
    }
  }
};

let passed = 0, failed = 0, skipped = 0;
const asyncQueue = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch(e) {
    console.log(`  ✗ ${name}`);
    console.log(`    → ${e.message}`);
    failed++;
  }
}

function testAsync(name, fn) {
  asyncQueue.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function section(name) { console.log(`\n=== ${name} ===`); }

const identity = require(path.join(__dirname, '../src/api/_identity.js'))
const utils    = require(path.join(__dirname, '../src/api/_utils.js'))
const memory   = require(path.join(__dirname, '../src/api/_memory.js'))
const state    = require(path.join(__dirname, '../src/api/_state.js'))

section('IDENTITY');

test('exports IDENTITY_COMPACT string', () => {
  assert(typeof identity.IDENTITY_COMPACT === 'string');
  assert(identity.IDENTITY_COMPACT.length > 0);
});
test('exports IDENTITY_FULL string', () => {
  assert(typeof identity.IDENTITY_FULL === 'string');
});
test('COMPACT shorter than FULL', () => {
  assert(identity.IDENTITY_COMPACT.length < identity.IDENTITY_FULL.length);
});
test('COMPACT does not contain FULL-only phrases', () => {
  assert(!identity.IDENTITY_COMPACT.includes('Blocked: state exact reason'));
});
test('maxAttempts === 2', () => {
  assert(identity.BEHAVIORAL_CONTRACTS.execution.maxAttempts === 2);
});
test('resumeSignals is a Set', () => {
  assert(identity.BEHAVIORAL_CONTRACTS.execution.resumeSignals instanceof Set);
});
test('resumeSignals contains required members', () => {
  const s = identity.BEHAVIORAL_CONTRACTS.execution.resumeSignals;
  for (const w of ['go','continue','retry','resume','proceed','?','ok','done']) {
    assert(s.has(w), `missing: ${w}`);
  }
});
test('maxClarifyingQuestions === 1', () => {
  assert(identity.BEHAVIORAL_CONTRACTS.loyalty.maxClarifyingQuestions === 1);
});
test('validateResponse with no context returns []', () => {
  const v = identity.validateResponse('any text', {});
  assert(Array.isArray(v) && v.length === 0);
});
test('validateResponse detects fabrication when taskActive=true', () => {
  const v = identity.validateResponse('i have both files read. now making the fixes', { taskActive: true });
  assert(v.length > 0);
});
test('validateResponse skips fabrication when taskActive not set', () => {
  const v = identity.validateResponse('i have both files', {});
  assert(v.length === 0);
});
test('DEMIS_VERSION is a non-empty string', () => {
  assert(typeof identity.DEMIS_VERSION === 'string' && identity.DEMIS_VERSION.length > 0);
});

section('UTILS');

test('verifySession throws 401 on missing token', () => {
  try { utils.verifySession({ headers: {}, cookies: {} }); assert(false); }
  catch(e) { assert(e.status === 401); }
});
test('verifySession throws 401 on wrong token', () => {
  process.env.SESSION_TOKEN = 'correct';
  try { utils.verifySession({ headers: { 'x-session-token': 'wrong' }, cookies: {} }); assert(false); }
  catch(e) { assert(e.status === 401); }
});
test('verifySession accepts correct token via header', () => {
  process.env.SESSION_TOKEN = 'test-secret';
  utils.verifySession({ headers: { 'x-session-token': 'test-secret' }, cookies: {} });
});
test('verifySession accepts correct token via cookie', () => {
  process.env.SESSION_TOKEN = 'cookie-secret';
  utils.verifySession({ headers: {}, cookies: { session: 'cookie-secret' } });
});
test('verifySession uses timingSafeEqual', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/api/_utils.js'), 'utf8');
  assert(src.includes('timingSafeEqual'));
  assert(!src.includes('token !== process.env.SESSION_TOKEN'));
});
test('uuid() returns string with hyphens', () => {
  const id = utils.uuid();
  assert(typeof id === 'string' && id.includes('-'));
});
test('routeModel: empty messages → Haiku', () => {
  assert(utils.routeModel([]) === 'claude-haiku-4-5-20251001');
});
test('routeModel: image → Sonnet', () => {
  assert(utils.routeModel([{ role:'user', content:[{type:'image',source:{}}] }]) === 'claude-sonnet-4-6');
});
test('routeModel: folatac with deploy → Sonnet', () => {
  assert(utils.routeModel([{ role:'user', content:'deploy the folatac dashboard' }]) === 'claude-sonnet-4-6');
});
test('routeModel: gcg → Sonnet', () => {
  assert(utils.routeModel([{ role:'user', content:'analyse gcg performance' }]) === 'claude-sonnet-4-6');
});
test('routeModel: legal analysis → Sonnet', () => {
  assert(utils.routeModel([{ role:'user', content:'legal analysis of the contract' }]) === 'claude-sonnet-4-6');
});
test('routeModel: go → Haiku', () => {
  assert(utils.routeModel([{ role:'user', content:'go' }]) === 'claude-haiku-4-5-20251001');
});
test('routeModel: deploy to production → Haiku', () => {
  assert(utils.routeModel([{ role:'user', content:'deploy to production' }]) === 'claude-haiku-4-5-20251001');
});
test('routeModel: plain question → Haiku', () => {
  assert(utils.routeModel([{ role:'user', content:'what time is it in tokyo' }]) === 'claude-haiku-4-5-20251001');
});

section('MEMORY');

test('exports VALID_CATEGORIES Set with 4 members', () => {
  assert(memory.VALID_CATEGORIES instanceof Set && memory.VALID_CATEGORIES.size === 4);
  for (const c of ['preferences','rules','failures','decisions']) {
    assert(memory.VALID_CATEGORIES.has(c), `missing ${c}`);
  }
});
test('parseMemoryInstruction: null on normal message', () => {
  assert(memory.parseMemoryInstruction('fix the bug in api/_utils.js') === null);
});
test('parseMemoryInstruction: remember → preferences, preserves case', () => {
  const r = memory.parseMemoryInstruction('remember that I use TastyTrade API');
  assert(r && r.category === 'preferences' && r.value === 'I use TastyTrade API');
});
test('parseMemoryInstruction: deduplicates same text', () => {
  const r1 = memory.parseMemoryInstruction('remember that use Haiku for simple tasks');
  const r2 = memory.parseMemoryInstruction('remember that use Haiku for simple tasks');
  assert(r1.field === r2.field);
});
test('parseMemoryInstruction: always → rules', () => {
  const r = memory.parseMemoryInstruction('always use squash merge for PRs');
  assert(r && r.category === 'rules');
});
test('parseMemoryInstruction: never → rules', () => {
  const r = memory.parseMemoryInstruction('never merge on Friday');
  assert(r && r.category === 'rules');
});
test('parseMemoryInstruction: decide that → decisions', () => {
  const r = memory.parseMemoryInstruction('decide that we always use squash merge');
  assert(r && r.category === 'decisions' && r.value.includes('squash merge'));
});
test('parseMemoryInstruction: decision: → decisions', () => {
  const r = memory.parseMemoryInstruction('decision: prefer Haiku for tool tasks');
  assert(r && r.category === 'decisions');
});
test('parseMemoryInstruction: failure note → failures', () => {
  const r = memory.parseMemoryInstruction('note that github_close_pr is broken');
  assert(r && r.category === 'failures' && r.field.includes('github_close_pr'));
});
test('parseMemoryInstruction: forget → category null', () => {
  const r = memory.parseMemoryInstruction('forget the squash merge rule');
  assert(r && r.action === 'remove' && r.category === null);
});
test('formatForPrompt: empty → null', () => {
  assert(memory.formatForPrompt({ preferences:{}, rules:{}, failures:{}, decisions:{} }) === null);
});
test('formatForPrompt: includes all categories', () => {
  const mem = {
    preferences: { p1: { value: 'use TastyTrade' } },
    rules:       { r1: { value: 'always squash' } },
    failures:    { 'github_close_pr': { value: 'known_failure' } },
    decisions:   { d1: { value: 'prefer Haiku' } },
  };
  const r = memory.formatForPrompt(mem);
  assert(r.includes('STANDING PREFERENCES') && r.includes('use TastyTrade'));
  assert(r.includes('STANDING RULES') && r.includes('always squash'));
  assert(r.includes('KNOWN FAILURES') && r.includes('github_close_pr'));
  assert(r.includes('PAST DECISIONS') && r.includes('prefer Haiku'));
});
test('formatForPrompt: omits empty categories', () => {
  const mem = { preferences: { p1: { value: 'pref' } }, rules:{}, failures:{}, decisions:{} };
  const r = memory.formatForPrompt(mem);
  assert(!r.includes('STANDING RULES') && !r.includes('KNOWN FAILURES'));
});
test('exports removeAny function', () => {
  assert(typeof memory.removeAny === 'function');
});

section('STATE');

test('exports TASK_TTL as positive number', () => {
  assert(typeof state.TASK_TTL === 'number' && state.TASK_TTL > 0);
});
test('exports all required functions', () => {
  const required = ['createTask','getTask','getActiveTask','updateStep',
    'setTaskRunning','setTaskStatus','advanceTask','blockTask','clearActiveTask'];
  for (const fn of required) assert(typeof state[fn] === 'function', `missing: ${fn}`);
});

const TEST_STEPS = [
  { label: 'Step A', fn: 'github_read_file', args: { path: 'x.js' } },
  { label: 'Step B', fn: 'compute', args: { fn: 'run_syntax_check', inputs: {} } },
];

testAsync('createTask: pending status and sets active pointer', async () => {
  Object.keys(kvStore).forEach(k => delete kvStore[k]);
  const task = await state.createTask('t001', 'Test', TEST_STEPS);
  assert(task.status === 'pending', `expected pending, got ${task.status}`);
  assert(task.steps[0].id === 't001_s0');
  const active = await state.getActiveTask();
  assert(active && active.id === 't001');
});
testAsync('getTask: null for unknown id', async () => {
  assert(await state.getTask('nonexistent') === null);
});
testAsync('updateStep: throws on negative index', async () => {
  try { await state.updateStep('t001', -1, { status:'done' }); assert(false); }
  catch(e) { assert(e.message.includes('range') || e.message.includes('-1')); }
});
testAsync('updateStep: throws on out-of-range index', async () => {
  try { await state.updateStep('t001', 99, { status:'done' }); assert(false); }
  catch(e) { assert(e.message.includes('range') || e.message.includes('99')); }
});
testAsync('setTaskRunning: pending → running', async () => {
  await state.createTask('t002', 'Run Test', TEST_STEPS);
  await state.setTaskRunning('t002');
  assert((await state.getTask('t002')).status === 'running');
});
testAsync('setTaskRunning: idempotent', async () => {
  await state.setTaskRunning('t002');
  assert((await state.getTask('t002')).status === 'running');
});
testAsync('advanceTask: increments current', async () => {
  await state.createTask('t003', 'Advance', TEST_STEPS);
  await state.advanceTask('t003');
  assert((await state.getTask('t003')).current === 1);
});
testAsync('advanceTask: past last step → done, removes pointer', async () => {
  await state.createTask('t004', 'Done', [TEST_STEPS[0]]);
  await state.advanceTask('t004');
  const t = await state.getTask('t004');
  assert(t.status === 'done');
  const active = await state.getActiveTask();
  assert(!active || active.id !== 't004');
});
testAsync('blockTask: permanent removes pointer', async () => {
  await state.createTask('t005', 'Block', TEST_STEPS);
  await state.blockTask('t005', 'step failed', false);
  assert((await state.getTask('t005')).status === 'blocked');
  const active = await state.getActiveTask();
  assert(!active || active.id !== 't005');
});
testAsync('blockTask: approval gate keeps pointer', async () => {
  await state.createTask('t006', 'Approval', TEST_STEPS);
  await state.blockTask('t006', 'APPROVAL_REQUIRED: confirm?', true);
  const active = await state.getActiveTask();
  assert(active && active.id === 't006');
});
testAsync('setTaskStatus: running restores pointer', async () => {
  await state.createTask('t007', 'Retry', TEST_STEPS);
  await state.blockTask('t007', 'error', false);
  await state.setTaskStatus('t007', 'running', null);
  const active = await state.getActiveTask();
  assert(active && active.id === 't007');
  assert((await state.getTask('t007')).error === null);
});
testAsync('clearActiveTask: task record remains', async () => {
  await state.createTask('t008', 'Clear', TEST_STEPS);
  await state.clearActiveTask();
  assert(await state.getActiveTask() === null);
  assert(await state.getTask('t008') !== null);
});

section('GITHUB (logic)');

test('readFile: directory → throws with listing', () => {
  function sim(data) {
    if (Array.isArray(data)) throw Object.assign(new Error(`readFile: is a directory. Contents: ${data.map(f=>f.name).join(', ')}`), { status:400 });
    if (!data.content) throw Object.assign(new Error('readFile: no content field'), { status:400 });
    return { content: Buffer.from(data.content,'base64').toString('utf8'), sha: data.sha };
  }
  try { sim([{name:'a.js'},{name:'b.js'}]); assert(false); }
  catch(e) { assert(e.status===400 && e.message.includes('directory') && e.message.includes('a.js')); }
});
test('readFile: no content field → throws', () => {
  function sim(data) {
    if (Array.isArray(data)) throw new Error('dir');
    if (!data.content) throw Object.assign(new Error('readFile: no content field'), { status:400 });
  }
  try { sim({ sha:'abc', type:'submodule' }); assert(false); }
  catch(e) { assert(e.message.includes('no content field')); }
});
test('_github exports all required functions', () => {
  const gh = require(path.join(__dirname, '../src/api/_github.js'));
  for (const fn of ['readFile','branchExists','createBranch','writeFile','openPR','mergePR']) {
    assert(typeof gh[fn] === 'function', `missing: ${fn}`);
  }
});
test('_github reads env vars inside ghFetch, not at module load', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/api/_github.js'), 'utf8');
  const firstFnPos = src.indexOf('async function ghFetch');
  const moduleLevel = src.slice(0, firstFnPos);
  assert(!moduleLevel.includes('process.env.GITHUB_OWNER'));
  assert(!moduleLevel.includes('process.env.GITHUB_TOKEN'));
});

section('PLANNER');

test('selectPlannerModel: deploy to production → Haiku', () => {
  const { selectPlannerModel } = require(path.join(__dirname, '../src/api/_planner.js'));
  assert(selectPlannerModel('deploy to production') === 'claude-haiku-4-5-20251001');
});
test('selectPlannerModel: folatac → Sonnet', () => {
  const { selectPlannerModel } = require(path.join(__dirname, '../src/api/_planner.js'));
  assert(selectPlannerModel('update folatac dashboard') === 'claude-sonnet-4-6');
});
test('selectPlannerModel: long instruction → Sonnet', () => {
  const { selectPlannerModel } = require(path.join(__dirname, '../src/api/_planner.js'));
  assert(selectPlannerModel('x'.repeat(201)) === 'claude-sonnet-4-6');
});
test('validatePlan: missing taskLabel → error', () => {
  const { validatePlan } = require(path.join(__dirname, '../src/api/_planner.js'));
  assert(validatePlan({ steps:[{label:'s',fn:'compute',args:{}}], canExecute:true }).some(e => e.includes('taskLabel')));
});
test('validatePlan: vercel_wait_for_deploy (old name) → error', () => {
  const { validatePlan } = require(path.join(__dirname, '../src/api/_planner.js'));
  assert(validatePlan({ taskLabel:'t', steps:[{label:'x',fn:'vercel_wait_for_deploy',args:{}}], canExecute:true }).some(e => e.includes('vercel_wait_for_deploy')));
});
test('validatePlan: vercel_check_deploy → passes', () => {
  const { validatePlan } = require(path.join(__dirname, '../src/api/_planner.js'));
  assert(validatePlan({ taskLabel:'t', steps:[{label:'x',fn:'vercel_check_deploy',args:{}}], canExecute:true }).filter(e => e.includes('unknown')).length === 0);
});
test('makePlannerSystem call is inside plan()', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/api/_planner.js'), 'utf8');
  const planPos = src.indexOf('async function plan(');
  const callPos = src.indexOf('= makePlannerSystem()');
  assert(callPos > planPos, 'call must be inside plan()');
});

section('EXECUTOR');

const { COMPUTE_REGISTRY, STEP_REGISTRY, createTask: execCreateTask } =
  require(path.join(__dirname, '../src/api/_executor.js'));

test('apply_routing_patch: handles SONNET_KW', () => {
  const content = `const SONNET_KW = ['plan','write'];\nconst complex = (last || '').length > 120;`;
  const r = COMPUTE_REGISTRY.apply_routing_patch({ file: { content } });
  assert(r.content.includes('SONNET_TRIGGERS') && r.content.includes('280'));
});
test('apply_routing_patch: handles SONNET_TRIGGERS', () => {
  const content = `const SONNET_TRIGGERS = ['plan'];\nconst complex = (last || '').length > 180;`;
  const r = COMPUTE_REGISTRY.apply_routing_patch({ file: { content } });
  assert(r.content.includes('280'));
});
test('apply_indicator_patch: idempotent', () => {
  const base = '<style>body{}</style><script>var x=1;</script>';
  const r1 = COMPUTE_REGISTRY.apply_indicator_patch({ file: { content: base } });
  const r2 = COMPUTE_REGISTRY.apply_indicator_patch({ file: { content: r1.content } });
  const c1 = (r1.content.match(/demis-pulse/g)||[]).length;
  const c2 = (r2.content.match(/demis-pulse/g)||[]).length;
  assert(c1 === c2, `idempotent: ${c1} vs ${c2}`);
});
test('apply_text_patch: throws when target not found', () => {
  try { COMPUTE_REGISTRY.apply_text_patch({ file:{content:'hello'}, find:'xyz', replace:'abc' }); assert(false); }
  catch(e) { assert(e.message.includes('not found')); }
});
test('run_syntax_check: passes valid JS', () => {
  const r = COMPUTE_REGISTRY.run_syntax_check({ file: { content: 'const x = 1;' } });
  assert(r.valid === true && typeof r.content === 'string');
});
test('run_syntax_check: throws on syntax error', () => {
  try { COMPUTE_REGISTRY.run_syntax_check({ file: { content: 'const x = {' } }); assert(false); }
  catch(e) { assert(e.message.includes('Syntax error')); }
});
test('run_syntax_check: throws on null', () => {
  try { COMPUTE_REGISTRY.run_syntax_check({ file: null }); assert(false); }
  catch(e) { assert(e.message.includes('no content')); }
});
test('github_merge_pr arity is 2', () => {
  assert(STEP_REGISTRY.github_merge_pr.length === 2);
});
test('vercel_check_deploy arity is 2', () => {
  assert(STEP_REGISTRY.vercel_check_deploy.length === 2);
});
test('summarize: PR preserves url and number', () => {
  function summarize(r) {
    if (!r) return null;
    if (r.url && r.number !== undefined) return { url:r.url, pr:r.number };
    if (r.url) return { url:r.url };
    return { ok:true };
  }
  const r = summarize({ url:'https://github.com/repo/pull/47', number:47 });
  assert(r.url && r.pr === 47);
});
test('vercel_check_deploy uses stateMap', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/api/_executor.js'), 'utf8');
  assert(src.includes('stateMap') && src.includes('BUILDING:'));
});

testAsync('createTask: resolves __from_step_index in write args', async () => {
  Object.keys(kvStore).forEach(k => delete kvStore[k]);
  const taskId = 'idx-test';
  const steps = [
    { label:'Read', fn:'github_read_file', args:{ path:'x.js' } },
    { label:'Patch', fn:'compute', args:{ fn:'apply_routing_patch', inputs:{ file:0 } } },
    { label:'Write', fn:'github_write_file', args:{ path:'x.js', branch:'b', message:'m', __from_step_index:1, __field:'content' } },
  ];
  await execCreateTask(taskId, 'test', steps);
  const t = await state.getTask(taskId);
  assert(t.steps[2].args.__from_step === `${taskId}_s1`);
  assert(t.steps[1].args.inputs.file === `${taskId}_s0`);
  assert(!('__from_step_index' in t.steps[2].args));
});
testAsync('createTask: resolves merge_pr __from_step_index', async () => {
  Object.keys(kvStore).forEach(k => delete kvStore[k]);
  const taskId = 'merge-test';
  const steps = [
    { label:'Open PR', fn:'github_open_pr', args:{ branch:'b', title:'t', body:'b' } },
    { label:'Merge PR', fn:'github_merge_pr', args:{ __from_step_index:0, __field:'number' } },
  ];
  await execCreateTask(taskId, 'test', steps);
  const t = await state.getTask(taskId);
  assert(t.steps[1].args.__from_step === `${taskId}_s0`);
  assert(t.steps[1].args.__field === 'number');
});
testAsync('createTask: throws on out-of-range index', async () => {
  try {
    await execCreateTask('bad', 'test', [{ label:'W', fn:'github_write_file', args:{ __from_step_index:5 } }]);
    assert(false);
  } catch(e) {
    assert(e.message.includes('range'));
  }
});

section('CHAT & TASK (source checks)');

const chatSrc = require('fs').readFileSync(path.join(__dirname, '../src/api/chat.js'), 'utf8');
const taskSrc = require('fs').readFileSync(path.join(__dirname, '../src/api/task.js'), 'utf8');

test('concurrent guard covers pending AND running', () => {
  assert(chatSrc.includes('isTaskActive') && chatSrc.includes("'pending'") && chatSrc.includes("'running'"));
});
test('sse() has try/catch in chat.js', () => {
  const fn = chatSrc.slice(chatSrc.indexOf('function sse('), chatSrc.indexOf('function startSSE('));
  assert(fn.includes('try') && fn.includes('catch'));
});
test('memory forget uses removeAny', () => {
  assert(chatSrc.includes('removeAny'));
});
test('TASK_SIGNALS: no bare commit or add a', () => {
  const block = chatSrc.slice(chatSrc.indexOf('const TASK_SIGNALS'), chatSrc.indexOf('];', chatSrc.indexOf('const TASK_SIGNALS')));
  assert(!block.includes("'commit'") && !block.includes("'add a'"));
});
test('memory ops return JSON not SSE', () => {
  assert(chatSrc.includes('res.json('));
});
test('task.js: no uuid import', () => {
  assert(!taskSrc.includes("'uuid'") && !taskSrc.includes('uuid()'));
});
test('task.js: no direct @vercel/kv require', () => {
  assert(!(taskSrc.match(/require.*@vercel\/kv/g)||[]).length);
});
test('task.js: retry uses setTaskStatus', () => {
  assert(taskSrc.includes('setTaskStatus'));
});
test('task.js: has /clear, /retry, /deploy-check', () => {
  assert(taskSrc.includes('/clear') && taskSrc.includes('/retry') && taskSrc.includes('/deploy-check'));
});
test('task.js sse() has try/catch', () => {
  const fn = taskSrc.slice(taskSrc.indexOf('function sse('), taskSrc.indexOf('module.exports'));
  assert(fn.includes('try') && fn.includes('catch'));
});

section('VERCEL CONFIG');

const vJson = JSON.parse(require('fs').readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));

test('no VERCEL_PROJECT_ID in env', () => {
  assert(!vJson.env.VERCEL_PROJECT_ID);
});
test('uses DEMIS_VERCEL_TOKEN not VERCEL_TOKEN', () => {
  assert(!vJson.env.VERCEL_TOKEN && vJson.env.DEMIS_VERCEL_TOKEN);
});
test('all required secrets present', () => {
  const required = ['GITHUB_TOKEN','GITHUB_OWNER','GITHUB_REPO','SESSION_TOKEN',
    'ANTHROPIC_API_KEY','DEMIS_VERCEL_TOKEN','PUSHOVER_TOKEN','PUSHOVER_USER'];
  for (const k of required) assert(vJson.env[k], `missing: ${k}`);
});
test('function maxDuration 60 for both handlers', () => {
  assert(vJson.functions['src/api/chat.js']?.maxDuration === 60);
  assert(vJson.functions['src/api/task.js']?.maxDuration === 60);
});

section('CROSS-MODULE INVARIANTS');

test('CI-1: chat.js uses executor.createTask not state.createTask', () => {
  assert(!chatSrc.includes('stateStore.createTask'));
});
test('CI-2: no module other than _github.js reads GITHUB_TOKEN', () => {
  const files = ['_utils.js','_memory.js','_state.js','_planner.js','_executor.js','chat.js','task.js'];
  for (const f of files) {
    const src = require('fs').readFileSync(path.join(__dirname, `../src/api/${f}`), 'utf8');
    assert(!src.includes('GITHUB_TOKEN'), `${f} must not read GITHUB_TOKEN`);
  }
});
test('CI-5: result persisted before step_done sent', () => {
  const execSrc = require('fs').readFileSync(path.join(__dirname, '../src/api/_executor.js'), 'utf8');
  const updatePos = execSrc.indexOf("status:  'done'");
  const sendPos   = execSrc.indexOf("type: 'step_done'");
  assert(updatePos < sendPos && updatePos > 0, `updatePos:${updatePos} sendPos:${sendPos}`);
});
test('CI-7: write rejects null/undefined but not empty string', () => {
  const execSrc = require('fs').readFileSync(path.join(__dirname, '../src/api/_executor.js'), 'utf8');
  assert(execSrc.includes('content === null || content === undefined'));
});
test('CI-8: SONNET_TRIGGERS checked before TOOL_PATTERNS', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '../src/api/_utils.js'), 'utf8');
  assert(src.indexOf('SONNET_TRIGGERS.some') < src.indexOf('TOOL_PATTERNS.some'));
});

async function runAll() {
  for (const { name, fn } of asyncQueue) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch(e) {
      console.log(`  ✗ ${name}`);
      console.log(`    → ${e.message}`);
      failed++;
    }
  }
  console.log('\n' + '═'.repeat(50));
  console.log(`  ${passed} passed  |  ${failed} failed  |  ${skipped} skipped`);
  if (failed > 0) { console.log('\n  SUITE FAILED'); process.exit(1); }
  else { console.log('\n  ALL TESTS PASSED'); }
}

runAll();
