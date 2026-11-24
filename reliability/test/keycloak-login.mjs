import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

export const issuer = 'http://localhost:8081/realms/cloudlib';
export const fixtureMemberRef = 'm7-recovery-student';

export async function loginAs(role, redirectUri) {
  const username = { mahasiswa: 'mhs_upn', petugas: 'petugas_upn', admin: 'admin_upn' }[role];
  const password = process.env['CLOUDLIB_' + role.toUpperCase() + '_PASSWORD'];
  assert.ok(password, 'Load private CloudLib fixture credentials before running the checks');

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const clientId = 'cloudlib-frontend';
  const authorize = new URL(issuer + '/protocol/openid-connect/auth');
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  const options = () => ({ redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const form = await fetch(authorize, options());
  assert.equal(form.status, 200, 'Expected the Keycloak sign-in form');
  const formHtml = await form.text();
  const formTag = formHtml.match(/<form\b[^>]*\bid="kc-form-login"[^>]*>/i)?.[0];
  const action = formTag?.match(/\baction="([^"]+)"/i)?.[1];
  assert.ok(action, 'The Keycloak sign-in form has no action');
  const loginUrl = new URL(action.replaceAll('&amp;', '&'), authorize);
  assert.ok(loginUrl.origin === authorize.origin &&
    loginUrl.pathname === '/realms/cloudlib/login-actions/authenticate',
  'Keycloak did not return its expected local sign-in endpoint');

  const cookie = form.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  const login = await fetch(loginUrl, {
    ...options(),
    method: 'POST',
    headers: { Cookie: cookie },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  assert.equal(login.status, 302, 'Expected Keycloak to redirect the fixture account after sign-in');
  const redirect = new URL(login.headers.get('location'));
  assert.ok(redirect.origin + redirect.pathname === redirectUri &&
    redirect.searchParams.get('state') === state && redirect.searchParams.has('code'),
  'The Keycloak redirect did not return the expected authorization code and state');

  const exchange = await fetch(issuer + '/protocol/openid-connect/token', {
    ...options(),
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: redirect.searchParams.get('code'),
      code_verifier: verifier,
    }),
  });
  assert.equal(exchange.status, 200, 'Keycloak did not exchange the PKCE code');
  const tokens = await exchange.json();
  const readClaims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.ok(readClaims(tokens.id_token).nonce === nonce, 'Keycloak ID token nonce did not match');
  const claims = readClaims(tokens.access_token);
  assert.ok(claims.iss === issuer && [claims.aud].flat().includes('cloudlib-api'),
    'Access token has the wrong issuer or API audience');
  assert.ok(claims.realm_access?.roles.includes(role) && claims.tenant === 'upnvj',
    'Access token lacks the fixture role or tenant assignment');
  if (role === 'mahasiswa') {
    assert.ok(claims.member_ref === fixtureMemberRef, 'Student token has the wrong member identity');
  }
  return tokens.access_token;
}
