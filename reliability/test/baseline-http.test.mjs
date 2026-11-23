import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { fixtureMemberRef, issuer, loginAs } from './keycloak-login.mjs';

const origin = new URL(process.env.CLOUDLIB_TEST_ORIGIN ?? 'http://cloudlib.localhost:8088');
const address = new URL(origin);
if (address.hostname === 'cloudlib.localhost') address.hostname = '127.0.0.1';

function cloudlib(path, { method = 'GET', headers = {}, data } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, address), {
      method,
      headers: { Host: origin.host, ...headers },
      signal: AbortSignal.timeout(15_000),
    }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('an anonymous caller cannot read the catalog using a known tenant header', async () => {
  const response = await cloudlib('/books', { headers: { 'X-Tenant': 'upnvj' } });
  assert.equal(response.status, 401);
});
test('the browser can discover the CloudLib realm at its canonical issuer', async () => {
  const response = await fetch(issuer + '/.well-known/openid-configuration', {
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).issuer, issuer);
});

async function api(path, token, expectedStatus, { tenant, body } = {}) {
  const headers = { Authorization: 'Bearer ' + token };
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (tenant) headers['X-Tenant'] = tenant;
  if (data) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(data);
  }
  const response = await cloudlib(path, { method: data ? 'POST' : 'GET', headers, data });
  assert.equal(response.status, expectedStatus, path + ' status');
  return expectedStatus < 300 ? JSON.parse(response.text) : undefined;
}

test('real Keycloak roles and tenant claims restrict catalog and tenant access', async () => {
  const redirectUri = origin.origin + '/';
  const staff = await loginAs('petugas', redirectUri);
  const student = await loginAs('mahasiswa', redirectUri);
  const admin = await loginAs('admin', redirectUri);

  const copies = await api('/books/copies', staff, 200);
  assert.ok(copies.some((copy) => copy.barcode === 'UPN-CC-001'), 'Staff cannot see its own catalog');
  assert.ok(!copies.some((copy) => copy.barcode === 'POL-K8-001'), 'Catalog leaked a second tenant');
  await api('/books', staff, 403, { tenant: 'poltek' });
  await api('/books', student, 200);
  await api('/dashboard/summary', student, 403);
  await api('/tenants', student, 403);
  const tenants = await api('/tenants', admin, 200);
  assert.ok(['upnvj', 'poltek'].every((code) => tenants.some((tenant) => tenant.code === code)),
    'Admin cannot see both tenant directory entries');
  await api('/dashboard/summary', admin, 403, { tenant: 'poltek' });
});

test('recovery transactions respect staff role, tenant scope and student identity', {
  skip: process.env.CLOUDLIB_TEST_TRANSACTIONS !== '1',
}, async () => {
  assert.equal(origin.origin, 'http://localhost:8089', 'Never write fixtures to the lab application');
  const redirectUri = origin.origin + '/';
  const staff = await loginAs('petugas', redirectUri);
  const student = await loginAs('mahasiswa', redirectUri);

  const copies = await api('/books/copies', staff, 200);
  const copy = copies.find((candidate) => candidate.status === 'AVAILABLE');
  assert.ok(copy, 'Recovery needs an available copy to verify circulation');
  await api('/loans', staff, 404, { body: { barcode: 'POL-K8-001', memberRef: fixtureMemberRef } });
  await api('/loans', student, 403, { body: { barcode: copy.barcode, memberRef: fixtureMemberRef } });
  const loan = await api('/loans', staff, 201, { body: { barcode: copy.barcode, memberRef: fixtureMemberRef } });
  const active = await api('/loans/active', student, 200);
  assert.ok(active.some((item) => item.id === loan.loanId && item.memberRef === fixtureMemberRef),
    'Student cannot see their active loan');
  const returned = await api('/loans/return', staff, 200, { body: { barcode: copy.barcode } });
  assert.ok(returned.loanId === loan.loanId && returned.status === 'AVAILABLE',
    'Return did not close the new loan and release its copy');

  const [computer] = await api('/computers', student, 200);
  assert.ok(computer, 'Recovery needs a computer to verify student reservations');
  const slotStart = new Date(Date.now() + 86_400_000).toISOString();
  const reservation = await api('/computers/reservations', student, 201, {
    body: { computerId: computer.id, slotStart, memberRef: 'm7-ignored-request-value' },
  });
  assert.ok(reservation.memberRef === fixtureMemberRef, 'Reservation ignored the trusted member claim');
  const visit = await api('/attendance/checkin', student, 201, {
    body: { memberRef: 'm7-ignored-request-value' },
  });
  assert.ok(visit.memberRef === fixtureMemberRef && visit.tenantCode === 'upnvj',
    'Check-in ignored the trusted member or tenant claim');
});
