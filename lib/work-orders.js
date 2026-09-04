// Durable queue for paid site-change work.
// One hash field per order means two customers filing at once cannot overwrite
// each other. A browser-supplied request id makes a network retry the same order.
import crypto from 'node:crypto';
import { cmd, parseHash } from './kv.js';

const KEY = 'ks:workorders';
const clean = (value, max = 800) => String(value == null ? '' : value).trim().slice(0, max);

function validId(value) {
  const id = clean(value, 100);
  return /^[A-Za-z0-9_-]{8,100}$/.test(id) ? id : '';
}

function parse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export async function getWorkOrder(id) {
  const key = validId(id);
  return key ? parse(await cmd(['HGET', KEY, key])) : null;
}

export async function createWorkOrder({ id, email, name, site, siteLabel, plan, requests } = {}) {
  const customer = clean(email, 320).toLowerCase();
  const items = (Array.isArray(requests) ? requests : []).map((x) => clean(x)).filter(Boolean).slice(0, 12);
  if (!customer.includes('@') || !items.length) throw new Error('valid work order required');
  const clientId = validId(id);
  // Scope a browser id to the authenticated customer. Even a guessed or reused
  // client id can never collide with another customer's queue item.
  const orderId = clientId
    ? 'wo_' + crypto.createHash('sha256').update(customer + '|' + clientId).digest('hex').slice(0, 32)
    : 'wo_' + crypto.randomUUID();
  const now = new Date().toISOString();
  const order = {
    id: orderId,
    email: customer,
    name: clean(name, 160),
    site: clean(site, 240),
    siteLabel: clean(siteLabel, 240),
    plan: clean(plan, 80),
    requests: items,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    completionNote: '',
    customerNotifiedAt: '',
  };
  const created = await cmd(['HSETNX', KEY, orderId, JSON.stringify(order)]);
  if (Number(created) === 1) return { order, duplicate: false };
  return { order: await getWorkOrder(orderId), duplicate: true };
}

export async function listWorkOrders(limit = 200) {
  const raw = parseHash(await cmd(['HGETALL', KEY]));
  return Object.values(raw).map(parse).filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.min(Math.max(1, Number(limit) || 200), 500));
}

export async function completeWorkOrder(id, note = '') {
  const order = await getWorkOrder(id);
  if (!order) return null;
  if (order.status === 'completed') return { order, duplicate: true };
  const now = new Date().toISOString();
  const completed = {
    ...order,
    status: 'completed',
    completedAt: now,
    updatedAt: now,
    completionNote: clean(note, 500),
  };
  await cmd(['HSET', KEY, completed.id, JSON.stringify(completed)]);
  return { order: completed, duplicate: false };
}

export async function markWorkOrderNotified(id) {
  const order = await getWorkOrder(id);
  if (!order) return null;
  const updated = { ...order, customerNotifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await cmd(['HSET', KEY, updated.id, JSON.stringify(updated)]);
  return updated;
}
