'use strict';

const crypto = require('crypto');

function verifySession(req) {
  const token    = req.headers?.['x-session-token'] || req.cookies?.session;
  const expected = process.env.SESSION_TOKEN || '';

  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });

  const tBuf = Buffer.from(String(token));
  const eBuf = Buffer.from(String(expected));

  const match = tBuf.length === eBuf.length &&
    crypto.timingSafeEqual(tBuf, eBuf);

  if (!match) throw Object.assign(new Error('Unauthorized'), { status: 401 });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-session-token');
}

const SONNET_TRIGGERS = [
  'legal analysis','regulatory','compliance review','contract interpretation',
  'operating agreement','articles of incorporation','trademark filing',
  'patent claim','legal implication','fiduciary',
  'financial model','portfolio analysis','tax implication','capital structure',
  'valuation method','options strategy review',
  'system architecture','refactor the entire','architectural decision',
  'design pattern for','database schema design',
  'critique this','comprehensive analysis','strategic recommendation',
  'synthesize','evaluate the tradeoffs','first principles',
  'folatac','gcg','iv regime','leap accumulation strategy',
  'path a framework','path b framework','bic signal','cles score',
];

const TOOL_PATTERNS = [
  'go','continue','retry','resume','read the file','commit the','push to',
  'create branch','open the pr','write to','run the test','run the script',
  'status of','is it done','proceed','deploy to','merge the pr','merge pr',
];

function routeModel(messages) {
  const last = messages[messages.length - 1];
  if (!last) return 'claude-haiku-4-5-20251001';

  let text = last.content || '';

  if (Array.isArray(text)) {
    if (text.some(b => b.type === 'image' || b.type === 'document')) {
      return 'claude-sonnet-4-6';
    }
    text = text.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
  }

  const lower = String(text).toLowerCase().trim();

  if (SONNET_TRIGGERS.some(t => lower.includes(t))) return 'claude-sonnet-4-6';
  if (TOOL_PATTERNS.some(p => lower.includes(p)))   return 'claude-haiku-4-5-20251001';

  return 'claude-haiku-4-5-20251001';
}

function splitSentences(text) {
  return text.match(/[^.!?]*[.!?]+/g) || [text];
}

function uuid() {
  return crypto.randomUUID();
}

module.exports = { verifySession, setCors, routeModel, splitSentences, uuid };
