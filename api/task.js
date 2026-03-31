'use strict';

const { verifySession, setCors } = require('./_utils');
const stateStore = require('./_state');
const { runTask, STEP_REGISTRY } = require('./_executor');

function startSSE(res) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
}

function sse(res) {
  return (event) => {
    try {
      const data = typeof event === 'string' ? event : JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
    } catch (_) {
      // Client disconnected
    }
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCors(res); return res.status(200).end(); }
  setCors(res);

  try { verifySession(req); } catch { return res.status(401).json({ error: 'Unauthorized' }); }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // POST /api/task/clear
  if (req.method === 'POST' && url.pathname.endsWith('/clear')) {
    await stateStore.clearActiveTask();
    return res.status(200).json({ cleared: true });
  }

  // POST /api/task/retry
  if (req.method === 'POST' && url.pathname.endsWith('/retry')) {
    const body = req.body || {};

    let task = await stateStore.getActiveTask();
    if (!task && body.taskId) task = await stateStore.getTask(body.taskId);
    if (!task) {
      return res.status(404).json({
        error: 'No task found. Provide taskId in body if active pointer was cleared.',
      });
    }

    const step = task.steps[task.current];
    if (!step) return res.status(400).json({ error: 'No current step on this task' });

    await stateStore.updateStep(task.id, task.current, {
      status:   'pending',
      attempts: 0,
      error:    body.approach ? `Approach: ${body.approach}` : null,
    });

    await stateStore.setTaskStatus(task.id, 'running', null);

    startSSE(res);
    const send = sse(res);
    send({ type: 'task_resume', label: task.label, reason: 'manual retry', step: step.label });
    await runTask(task.id, send);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // POST /api/task/deploy-check
  if (req.method === 'POST' && url.pathname.endsWith('/deploy-check')) {
    const task = await stateStore.getActiveTask();
    if (!task) return res.status(404).json({ error: 'No active task' });

    const deployStep = [...task.steps].reverse().find(
      s => s.fn === 'vercel_deploy' && s.status === 'done' && s.result?.deployment_id
    );
    if (!deployStep) {
      return res.status(404).json({ error: 'No completed deploy step found in active task' });
    }

    try {
      const result = await STEP_REGISTRY.vercel_check_deploy(
        { deployment_id: deployStep.result.deployment_id },
        null
      );
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET /api/task
  if (req.method === 'GET') {
    const id   = url.searchParams.get('id');
    const task = id
      ? await stateStore.getTask(id)
      : await stateStore.getActiveTask();

    if (!task) return res.status(200).json({ active: false });

    return res.status(200).json({
      active: true,
      task: {
        id:         task.id,
        label:      task.label,
        status:     task.status,
        current:    task.current,
        total:      task.steps.length,
        error:      task.error,
        steps:      task.steps.map(s => ({
          label:      s.label,
          status:     s.status,
          error:      s.error,
          attempts:   s.attempts,
          started_at: s.started_at,
          done_at:    s.done_at,
          result:     s.fn === 'vercel_deploy' ? s.result : undefined,
        })),
        created_at: task.created_at,
        updated_at: task.updated_at,
      },
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
