'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { verifySession, setCors, routeModel, uuid } = require('./_utils');
const { IDENTITY_COMPACT, IDENTITY_FULL, BEHAVIORAL_CONTRACTS, validateResponse } = require('./_identity');
const stateStore = require('./_state');
const memStore   = require('./_memory');
const { plan, validatePlan } = require('./_planner');
const { runTask, createTask } = require('./_executor');

const client = new Anthropic();
const RESUME = BEHAVIORAL_CONTRACTS.execution.resumeSignals;

function lastText(messages) {
  const m = messages[messages.length - 1];
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
  }
  return '';
}

function isResume(text) {
  return RESUME.has(text.trim().toLowerCase());
}

function isApprovalGate(task) {
  return task?.status === 'blocked' &&
    task.steps[task.current]?.error?.startsWith('APPROVAL_REQUIRED');
}

function isTaskActive(task) {
  return task && (task.status === 'running' || task.status === 'pending');
}

const TASK_SIGNALS = [
  'pull request','open a pr','create a branch','push to',
  'update the file','fix the bug','fix the code','deploy to',
  'merge the pr','merge pr','read the file','write to the',
  'change the code','refactor the','implement the',
  'open pr','commit the','commit this file',
];

function classifyIntent(text) {
  const lower = text.toLowerCase();
  if (TASK_SIGNALS.some(s => lower.includes(s))) return 'task';
  if (text.length > 150 && lower.includes(' and ')) return 'task';
  return 'chat';
}

function sse(res) {
  return (event) => {
    try {
      const data = typeof event === 'string' ? event : JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
    } catch (_) {
      // Client disconnected — task continues in KV, resumable via 'go'
    }
  };
}

function startSSE(res) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCors(res); return res.status(200).end(); }
  setCors(res);

  try { verifySession(req); } catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const { messages = [] } = req.body || {};
  const text = lastText(messages);

  const activeTask = await stateStore.getActiveTask().catch(() => null);

  // 1. APPROVAL GATE
  if (activeTask && isApprovalGate(activeTask)) {
    startSSE(res);
    const send = sse(res);
    await stateStore.updateStep(activeTask.id, activeTask.current, {
      status:   'done',
      result:   { answer: text, approved_at: new Date().toISOString() },
      done_at:  new Date().toISOString(),
    });
    await stateStore.advanceTask(activeTask.id);
    send({ type: 'task_resume', label: activeTask.label, reason: 'approval received' });
    await runTask(activeTask.id, send);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 2. RESUME SIGNAL
  if (activeTask && isResume(text)) {
    startSSE(res);
    const send = sse(res);
    if (activeTask.status === 'blocked') {
      send({ type: 'task_blocked', reason: activeTask.error, label: activeTask.label });
    } else {
      send({ type: 'task_resume', label: activeTask.label, current: activeTask.current, total: activeTask.steps.length });
      await runTask(activeTask.id, send);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 3. ACTIVE TASK GUARD
  if (isTaskActive(activeTask)) {
    startSSE(res);
    const send = sse(res);
    const step = activeTask.steps[activeTask.current];
    send({
      type: 'text',
      text: `Task "${activeTask.label}" is ${activeTask.status}. Step ${activeTask.current + 1}/${activeTask.steps.length}: "${step?.label}". Send "go" to resume if paused, or POST /api/task/clear to cancel.`,
    });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 4. MEMORY INSTRUCTION
  const memOp = memStore.parseMemoryInstruction(text);
  if (memOp) {
    if (memOp.action === 'set') {
      await memStore.set(memOp.category, memOp.field, memOp.value);
      return res.json({ type: 'memory_set', category: memOp.category, value: memOp.value });
    } else {
      if (memOp.category === null) {
        const removed = await memStore.removeAny(memOp.field);
        return res.json({ type: 'memory_cleared', field: memOp.field, removed });
      } else {
        await memStore.remove(memOp.category, memOp.field);
        return res.json({ type: 'memory_cleared', category: memOp.category, field: memOp.field });
      }
    }
  }

  // 5. LOAD MEMORY
  const mem      = await memStore.readAll().catch(() => ({}));
  const memBlock = memStore.formatForPrompt(mem);

  // 6. TASK PLANNING
  const intent = classifyIntent(text);
  if (intent === 'task') {
    startSSE(res);
    const send = sse(res);
    send({ type: 'planning', text: 'Planning...' });

    let taskPlan;
    try {
      taskPlan = await plan(text, memBlock);
    } catch (e) {
      send({ type: 'text', text: `Planner error: ${e.message}` });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    if (!taskPlan.canExecute) {
      const msg = [taskPlan.blockers?.join(' '), taskPlan.clarifyingQuestion]
        .filter(Boolean).join('\n');
      send({ type: 'text', text: msg });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const errs = validatePlan(taskPlan);
    if (errs.length) {
      send({ type: 'text', text: `Plan invalid: ${errs.join(', ')}` });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const taskId = uuid();
    try {
      await createTask(taskId, taskPlan.taskLabel, taskPlan.steps);
    } catch (e) {
      send({ type: 'text', text: `Task creation failed: ${e.message}` });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    await runTask(taskId, send);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 7. STANDARD CHAT
  startSSE(res);
  const send  = sse(res);
  const model = routeModel(messages);
  const identity = model.includes('haiku') ? IDENTITY_COMPACT : IDENTITY_FULL;
  const system   = memBlock ? `${identity}\n\n${memBlock}` : identity;

  const stream = await client.messages.stream({
    model, max_tokens: 1024, system, messages,
  });

  let full = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      full += chunk.delta.text;
      send({ type: 'text', text: chunk.delta.text });
    }
  }

  if (activeTask) {
    const violations = validateResponse(full, { taskActive: true });
    if (violations.length) console.error('IDENTITY_VIOLATIONS', violations);
  }

  res.write('data: [DONE]\n\n');
  res.end();
};
