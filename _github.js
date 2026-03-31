'use strict';

async function ghFetch(path, opts = {}) {
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const base  = `https://api.github.com/repos/${owner}/${repo}`;

  const url = path.startsWith('http') ? path : `${base}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization:          `Bearer ${token}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':         'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { message: text }; }

  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${path}: ${json.message || text}`);
    err.status = res.status;
    err.github = json;
    throw err;
  }

  return json;
}

async function readFile(filePath, ref = 'main') {
  const data = await ghFetch(`/contents/${filePath}?ref=${ref}`);

  if (Array.isArray(data)) {
    throw Object.assign(
      new Error(`readFile: "${filePath}" is a directory. Contents: ${data.map(f => f.name).join(', ')}`),
      { status: 400 }
    );
  }

  if (!data.content) {
    throw Object.assign(
      new Error(`readFile: "${filePath}" has no content field — may be a submodule or symlink`),
      { status: 400 }
    );
  }

  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content, sha: data.sha };
}

async function branchExists(branch) {
  try {
    await ghFetch(`/git/refs/heads/${branch}`);
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

async function createBranch(branch, fromRef = 'main') {
  if (await branchExists(branch)) return branch;
  const base = await ghFetch(`/git/refs/heads/${fromRef}`);
  const sha  = base.object.sha;
  await ghFetch('/git/refs', {
    method: 'POST',
    body:   { ref: `refs/heads/${branch}`, sha },
  });
  return branch;
}

async function writeFile(filePath, content, branch, message) {
  let sha;
  try {
    const current = await readFile(filePath, branch);
    sha = current.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  return ghFetch(`/contents/${filePath}`, {
    method: 'PUT',
    body: {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    },
  });
}

async function openPR(branch, title, body, base = 'main') {
  const owner    = process.env.GITHUB_OWNER;
  const existing = await ghFetch(`/pulls?head=${owner}:${branch}&state=open`);
  if (existing.length > 0) return existing[0];
  return ghFetch('/pulls', {
    method: 'POST',
    body:   { title, body, head: branch, base },
  });
}

async function mergePR(number, method = 'squash') {
  await ghFetch(`/pulls/${number}/merge`, {
    method: 'PUT',
    body:   { merge_method: method },
  });
  return { merged: true, number };
}

module.exports = { readFile, branchExists, createBranch, writeFile, openPR, mergePR };
