import { readFile } from 'node:fs/promises';

const server = 'http://localhost:8081';
const root = server + '/admin/realms';
const realm = root + '/cloudlib';
const accessTokenUrl = server + '/realms/master/protocol/openid-connect/token';

async function expectStatus(url, options, status, step) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  if (response.status !== status) throw new Error(step + ': HTTP ' + response.status);
  return response;
}

async function provision() {
  const definitions = [
    ['petugas', process.env.CLOUDLIB_PETUGAS_PASSWORD],
    ['mahasiswa', process.env.CLOUDLIB_MAHASISWA_PASSWORD],
    ['admin', process.env.CLOUDLIB_ADMIN_PASSWORD],
  ];
  const { KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD } = process.env;
  if (![KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD, ...definitions.map(([, value]) => value)].every(Boolean)) {
    throw new Error('Load the local infrastructure and recovery credentials through Node --env-file');
  }

  const discovery = await fetch(server + '/realms/cloudlib/.well-known/openid-configuration', {
    signal: AbortSignal.timeout(15_000),
  });
  if (discovery.status !== 404) throw new Error('Provisioning requires a missing CloudLib realm');

  const login = await expectStatus(accessTokenUrl, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: KEYCLOAK_ADMIN,
      password: KEYCLOAK_ADMIN_PASSWORD,
    }),
  }, 200, 'Local Keycloak administrator sign-in');
  const token = (await login.json()).access_token;
  const adminRequest = (url, method, body, status, step) => expectStatus(url, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    method,
    body: JSON.stringify(body),
  }, status, step);

  const config = JSON.parse(await readFile(new URL('../keycloak/cloudlib-realm.json', import.meta.url)));
  await adminRequest(root, 'POST', config, 201, 'Import CloudLib realm');

  const profileUrl = realm + '/users/profile';
  const profile = await (await adminRequest(profileUrl, 'GET', undefined, 200, 'Read user profile')).json();
  for (const [name, max] of [['tenant', 30], ['member_ref', 80]]) {
    profile.attributes.push({
      name,
      permissions: { view: ['admin'], edit: ['admin'] },
      validations: { length: { max } },
    });
  }
  await adminRequest(profileUrl, 'PUT', profile, 200, 'Protect custom identity attributes');

  for (const [role, value] of definitions) {
    const username = { mahasiswa: 'mhs_upn', petugas: 'petugas_upn', admin: 'admin_upn' }[role];
    const attributes = { tenant: ['upnvj'] };
    if (role === 'mahasiswa') attributes.member_ref = ['m7-recovery-student'];
    const created = await adminRequest(realm + '/users', 'POST', {
      username,
      firstName: { mahasiswa: 'Mahasiswa', petugas: 'Petugas', admin: 'Admin' }[role],
      lastName: 'UPNVJ',
      email: username + '@example.invalid',
      emailVerified: true,
      enabled: true,
      attributes,
      credentials: [{ type: 'password', value, temporary: false }],
    }, 201, 'Create fixture ' + role);
    const id = new URL(created.headers.get('location')).pathname.split('/').at(-1);
    const roleMapping = await (await adminRequest(realm + '/roles/' + role, 'GET', undefined, 200, 'Read role ' + role)).json();
    await adminRequest(realm + '/users/' + id + '/role-mappings/realm', 'POST',
      [{ id: roleMapping.id, name: role }], 204, 'Assign role ' + role);
  }
  console.log('Provisioned the CloudLib realm and three local fixture identities.');
}

try {
  await provision();
} catch (error) {
  console.error('Keycloak provisioning failed: ' + error.message);
  process.exitCode = 1;
}
