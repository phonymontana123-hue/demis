'use strict';

const { kv } = require('@vercel/kv');

const TASK_TTL = 60 * 60 * 24 * 7;

const taskKey  = (id) => `demis:task:${id}`;
const activeKey = () => 'demis:active_task';

async function createTask(id, label, steps) {
  const now = new Date().toISOString();
  const task = {
    id,
    label,
    status: 'pending',
    steps: steps.map((s, i) => ({
      id:         `${id}_s${i}`,
      label:      s.label,
      fn:         s.fn,
      args:       s.args || {},
      status:     'pending',
      result:     null,
      error:      null,
      attempts:   0,
      started_at: null,
      done_at:    null,
    })),
    current:    0,
    error:      null,
    created_at: now,
    updated_at: now,
  };
  await kv.set(taskKey(id), task, { ex: TASK_TTL });
  await kv.set(activeKey(), id,   { ex: TASK_TTL });
  return task;
}

async function getTask(id) {
  return kv.get(taskKey(id));
}

async function getActiveTask() {
  const id = await kv.get(activeKey());
  if (!id) return null;
  return getTask(id);
}

async function updateStep(taskId, stepIndex, patch) {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (stepIndex < 0 || stepIndex >= task.steps.length) {
    throw new Error(
      `Step index ${stepIndex} out of range (task ${taskId} has ${task.steps.length} steps)`
    );
  }
  Object.assign(task.steps[stepIndex], patch);
  task.updated_at = new Date().toISOString();
  await kv.set(taskKey(taskId), task, { ex: TASK_TTL });
  return task;
}

async function setTaskRunning(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status !== 'pending') return task;
  task.status = 'running';
  task.updated_at = new Date().toISOString();
  await kv.set(taskKey(taskId), task, { ex: TASK_TTL });
  return task;
}

async function setTaskStatus(taskId, status, errorMsg = null) {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.status = status;
  if (errorMsg !== undefined) task.error = errorMsg;
  task.updated_at = new Date().toISOString();
  await kv.set(taskKey(taskId), task, { ex: TASK_TTL });
  if (status === 'running') {
    await kv.set(activeKey(), taskId, { ex: TASK_TTL });
  }
  return task;
}

async function advanceTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.current += 1;
  task.updated_at = new Date().toISOString();
  if (task.current >= task.steps.length) {
    task.status = 'done';
    await kv.del(activeKey());
  }
  await kv.set(taskKey(taskId), task, { ex: TASK_TTL });
  return task;
}

async function blockTask(taskId, reason, isApprovalGate = false) {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  task.status = 'blocked';
  task.error  = reason;
  task.updated_at = new Date().toISOString();
  await kv.set(taskKey(taskId), task, { ex: TASK_TTL });
  if (!isApprovalGate) await kv.del(activeKey());
  return task;
}

async function clearActiveTask() {
  await kv.del(activeKey());
}

module.exports = {
  TASK_TTL,
  createTask,
  getTask,
  getActiveTask,
  updateStep,
  setTaskRunning,
  setTaskStatus,
  advanceTask,
  blockTask,
  clearActiveTask,
};
