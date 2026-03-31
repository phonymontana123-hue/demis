'use strict';

const stateStore = require('./_state');
const github     = require('./_github');
const memory     = require('./_memory');
const { BEHAVIORAL_CONTRACTS } = require('./_identity');

const MAX_ATTEMPTS = BEHAVIORAL_CONTRACTS.execution.maxAttempts;

const COMPUTE_REGISTRY = {

  apply_routing_patch({ file }) {
    let { content } = file;
    content = content.replace(
      /const (SONNET_KW|SONNET_TRIGGERS) = \[[\s\S]*?\];/,
      `const SONNET_TRIGGERS = [
  'legal analysis','regulatory','compliance review','contract interpretation',
  'operating agreement','articles of incorporation','trademark filing',
  'patent claim','legal implication','fiduciary',
  'financial model','portfolio analysis','tax implication','capital structure',
  'valuation method','options strategy review',
  'system architecture','refactor the entire','architectural decision',
  'design pattern for','database schema design',
  'critique this','comprehensive analysis','strategic recommendation',
  'synthesize','evaluate the tradeoffs','first principles',
  'folatac','gcg','iv regime','leap accumulation',
  'path a','path b','path c','bic signal','cles score',
];`
    );
    content = content.replace(/SONNET_KW\.some/g, 'SONNET_TRIGGERS.some');
    content = content.replace(
      /const complex = \(last \|\| ''\)\.length > \d+/,
      `const complex = (last || '').length > 280`
    );
    return { content };
  },

  apply_indicator_patch({ file }) {
    let { content } = file;
    const css = `\n@keyframes demis-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}\n#sdot.state-active{animation:demis-pulse .9s ease-in-out infinite!important;background:#00c8f0!important;box-shadow:0 0 8px 2px rgba(0,200,240,.4)}\n#sdot.state-blocked{animation:demis-pulse .3s ease-in-out infinite!important;background:#ef4444!important}\n#sdot.state-idle{animation:none;opacity:.35}`;
    const js  = `\nfunction _demisSetActivity(s){const d=document.getElementById('sdot');if(!d)return;d.classList.remove('state-active','state-blocked','state-idle');d.classList.add('state-'+s);}\nif(typeof S!=='undefined'){let _sv=false;Object.defineProperty(S,'streaming',{get(){return _sv},set(v){_sv=v;_demisSetActivity(v?'active':'idle')},configurable:true});}`;
    if (!content.includes('demis-pulse'))       content = content.replace('</style>',  css + '\n</style>');
    if (!content.includes('_demisSetActivity')) content = content.replace('</script>', js  + '\n</script>');
    return { content };
  },

  apply_text_patch({ file, find, replace }) {
    if (!file.content.includes(find)) throw new Error('apply_text_patch: target string not found');
    return { content: file.content.replace(find, replace) };
  },

  run_syntax_check({ file }) {
    const src = (file && typeof file === 'object') ? file.content : file;
    if (typeof src !== 'string') throw new Error('run_syntax_check: no content to check');
    try {
      new Function(src);
      return { valid: true, content: src };
    } catch (e) {
      throw new Error(`Syntax error: ${e.message}`);
    }
  },
};

function resolveFromStep(args, task) {
  if (!args.__from_step) return null;
  const src = task.steps.find(s => s.id === args.__from_step);
  if (!src) throw new Error(`Step ${args.__from_step} not found in task`);
  if (src.status !== 'done') {
    throw new Error(`Dependency ${args.__from_step} not complete (status: ${src.status})`);
  }
  return args.__field ? src.result[args.__field] : src.result;
}

const STEP_REGISTRY = {

  async github_read_file({ path, ref = 'main' }) {
    return github.readFile(path, ref);
  },

  async github_create_branch({ branch, from = 'main' }) {
    await github.createBranch(branch, from);
    return { branch };
  },

  async github_write_file(args, task) {
    const { path, branch, message } = args;
    let content = args.content;
    if (args.__from_step) {
      content = resolveFromStep(args, task);
    }
    if (content === null || content === undefined) {
      throw new Error(`No content resolved for write to ${path}`);
    }
    return github.writeFile(path, content, branch, message);
  },

  async github_open_pr({ branch, title, body, base = 'main' }) {
    const pr = await github.openPR(branch, title, body, base);
    return { url: pr.html_url, number: pr.number };
  },

  async github_merge_pr(args, task) {
    let number = args.number;
    if (args.__from_step) {
      number = resolveFromStep(args, task);
    }
    if (number === null || number === undefined) {
      throw new Error('github_merge_pr: no PR number resolved');
    }
    return github.mergePR(number, args.method || 'squash');
  },

  async compute({ fn, inputs = {} }, task) {
    const resolved = {};
    for (const [key, stepId] of Object.entries(inputs)) {
      const s = task.steps.find(s => s.id === stepId);
      if (!s) throw new Error(`Compute input step '${stepId}' not found`);
      if (s.status !== 'done') {
        throw new Error(`Compute input '${key}' from '${stepId}' not ready (status: ${s.status})`);
      }
      resolved[key] = s.result;
    }
    const fn_ = COMPUTE_REGISTRY[fn];
    if (!fn_) throw new Error(`Unknown compute fn: "${fn}"`);
    return fn_(resolved);
  },

  async vercel_deploy({ environment = 'production' }) {
    const pid = process.env.VERCEL_PROJECT_ID;
    if (!pid) throw new Error('VERCEL_PROJECT_ID not set');
    const res = await fetch('https://api.vercel.com/v13/deployments', {
      method:  'POST',
      headers: { Authorization: `Bearer ${process.env.DEMIS_VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: pid, target: environment, gitSource: { type: 'github', ref: 'main' } }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(`Deploy failed: ${d.error?.message || JSON.stringify(d)}`);
    return { deployment_id: d.id, url: d.url, status: 'deploying' };
  },

  async vercel_check_deploy(args, task) {
    let deployment_id = args.deployment_id;
    if (args.__from_step && task) {
      deployment_id = resolveFromStep(args, task);
    }
    if (!deployment_id) throw new Error('vercel_check_deploy: no deployment_id resolved');

    const res = await fetch(`https://api.vercel.com/v13/deployments/${deployment_id}`, {
      headers: { Authorization: `Bearer ${process.env.DEMIS_VERCEL_TOKEN}` },
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Vercel API error ${res.status}: ${e.error?.message || 'unknown'}`);
    }
    const d = await res.json();

    const stateMap = {
      READY: 'ready', ERROR: 'error', BUILDING: 'building',
      QUEUED: 'queued', INITIALIZING: 'initializing',
      DEPLOYING: 'deploying', CANCELED: 'canceled',
    };
    const status = stateMap[d.readyState] || (d.readyState || 'building').toLowerCase();

    if (status === 'ready') return { status: 'ready', url: `https://${d.alias?.[0] || d.url}` };
    if (status === 'error') throw new Error(`Deployment failed: ${d.errorMessage || 'unknown'}`);
    return { status, deployment_id };
  },

  async memory_set({ category, field, value }) {
    return memory.set(category, field, value);
  },

  async notify_anthony({ message }) {
    if (!process.env.PUSHOVER_TOKEN || !process.env.PUSHOVER_USER) {
      return { sent: false, reason: 'Pushover not configured' };
    }
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        token:   process.env.PUSHOVER_TOKEN,
        user:    process.env.PUSHOVER_USER,
        message: `DEMIS: ${message}`,
        title:   'DEMIS',
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Pushover failed: ${e.errors?.join(', ') || res.status}`);
    }
    return { sent: true, message };
  },

  async require_anthony_approval({ question, options = [] }) {
    throw Object.assign(
      new Error(`APPROVAL_REQUIRED: ${question}`),
      { isApprovalGate: true, options }
    );
  },
};

function summarize(r) {
  if (!r) return null;
  if (r.url && r.number !== undefined) return { url: r.url, pr: r.number };
  if (r.url)              return { url: r.url };
  if (r.branch)           return { branch: r.branch };
  if (r.valid !== undefined) return { valid: r.valid };
  if (r.merged)           return { merged: true };
  if (r.status)           return { status: r.status };
  if (r.number)           return { pr: r.number };
  return { ok: true };
}

async function executeStep(task, idx, send) {
  const step     = task.steps[idx];
  const attempts = (step.attempts || 0) + 1;

  await stateStore.updateStep(task.id, idx, {
    status:     'running',
    attempts,
    started_at: new Date().toISOString(),
  });
  send({ type: 'step_start', step: step.label, index: idx, total: task.steps.length });

  try {
    const fn = STEP_REGISTRY[step.fn];
    if (!fn) throw new Error(`Unknown step fn: "${step.fn}"`);

    const fresh  = await stateStore.getTask(task.id);
    const result = await fn(step.args, fresh);

    await stateStore.updateStep(task.id, idx, {
      status:  'done',
      result,
      error:   null,
      done_at: new Date().toISOString(),
    });
    send({ type: 'step_done', step: step.label, index: idx, result: summarize(result) });
    return { ok: true };

  } catch (err) {
    if (err.isApprovalGate) {
      await stateStore.updateStep(task.id, idx, { status: 'pending', error: err.message, attempts });
      return { ok: false, isApprovalGate: true, error: err.message, options: err.options };
    }
    const exhausted = attempts >= MAX_ATTEMPTS;
    await stateStore.updateStep(task.id, idx, {
      status:   exhausted ? 'failed' : 'pending',
      error:    err.message,
      attempts,
    });
    send({ type: 'step_error', step: step.label, error: err.message, attempts, max: MAX_ATTEMPTS });
    return { ok: false, error: err.message, exhausted };
  }
}

async function runTask(taskId, send) {
  const task = await stateStore.getTask(taskId);
  if (!task) { send({ type: 'error', error: `Task ${taskId} not found` }); return; }

  await stateStore.setTaskRunning(taskId);
  send({ type: 'task_start', label: task.label, steps: task.steps.length });

  while (true) {
    const fresh   = await stateStore.getTask(taskId);
    const current = fresh.current;

    if (current >= fresh.steps.length) break;

    const step = fresh.steps[current];
    if (!step) {
      send({ type: 'task_error', error: `Step ${current} missing from task ${taskId}` });
      return;
    }

    if (step.status === 'done') {
      send({ type: 'step_skip', step: step.label, index: current });
      await stateStore.advanceTask(taskId);
      continue;
    }

    if ((step.attempts || 0) >= MAX_ATTEMPTS) {
      const reason = `"${step.label}" failed ${MAX_ATTEMPTS}x. Last: ${step.error}`;
      await stateStore.blockTask(taskId, reason, false);
      send({ type: 'task_blocked', reason });
      return;
    }

    const out = await executeStep(fresh, current, send);

    if (!out.ok) {
      if (out.isApprovalGate) {
        await stateStore.blockTask(taskId, out.error, true);
        send({
          type:     'approval_required',
          question: out.error.replace('APPROVAL_REQUIRED:', '').trim(),
          options:  out.options,
        });
        return;
      }
      if (out.exhausted) {
        const reason = `"${step.label}" exhausted. ${out.error}`;
        await stateStore.blockTask(taskId, reason, false);
        send({ type: 'task_blocked', reason });
        return;
      }
      send({ type: 'task_paused', step: step.label, error: out.error });
      return;
    }

    await stateStore.advanceTask(taskId);
  }

  const final = await stateStore.getTask(taskId);
  if (final?.status === 'done') {
    send({ type: 'task_done', label: final.label });
  } else {
    send({ type: 'task_error', error: `Task ended in unexpected status: ${final?.status}` });
  }
}

async function createTask(taskId, label, steps) {
  const ids = steps.map((_, i) => `${taskId}_s${i}`);

  const resolved = steps.map((s, i) => {
    const args = { ...(s.args || {}) };

    if (typeof args.__from_step_index === 'number') {
      const idx = args.__from_step_index;
      if (idx < 0 || idx >= ids.length) {
        throw new Error(`Step ${i}: __from_step_index ${idx} out of range (${ids.length} steps)`);
      }
      args.__from_step = ids[idx];
      delete args.__from_step_index;
    }

    if (args.inputs && typeof args.inputs === 'object') {
      const resolvedInputs = {};
      for (const [key, val] of Object.entries(args.inputs)) {
        if (typeof val === 'number') {
          if (val < 0 || val >= ids.length) {
            throw new Error(`Step ${i} input '${key}': index ${val} out of range`);
          }
          resolvedInputs[key] = ids[val];
        } else {
          resolvedInputs[key] = val;
        }
      }
      args.inputs = resolvedInputs;
    }

    if (
      args.deployment_id &&
      typeof args.deployment_id === 'object' &&
      typeof args.deployment_id.__from_step_index === 'number'
    ) {
      const idx = args.deployment_id.__from_step_index;
      if (idx < 0 || idx >= ids.length) {
        throw new Error(`Step ${i} deployment_id: index ${idx} out of range`);
      }
      args.__from_step = ids[idx];
      args.__field     = args.deployment_id.__field || 'deployment_id';
      delete args.deployment_id;
    }

    return { ...s, args };
  });

  return stateStore.createTask(taskId, label, resolved);
}

module.exports = { runTask, createTask, STEP_REGISTRY, COMPUTE_REGISTRY };
