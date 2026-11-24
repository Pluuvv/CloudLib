// Complete Keycloak sync script for CloudLib
async function setup() {
  const loginRes = await fetch('http://localhost:8081/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: 'admin',
      password: 'admin'
    })
  });
  const token = (await loginRes.json()).access_token;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  // 1. Enable custom attributes in Keycloak User Profile SPI
  const profile = await (await fetch('http://localhost:8081/admin/realms/cloudlib/users/profile', { headers })).json();
  const existingAttrNames = profile.attributes.map(a => a.name);
  for (const attr of ['tenant', 'member_ref']) {
    if (!existingAttrNames.includes(attr)) {
      profile.attributes.push({
        name: attr,
        displayName: attr,
        permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] },
        validations: { length: { max: 100 } }
      });
    }
  }
  const putProfileRes = await fetch('http://localhost:8081/admin/realms/cloudlib/users/profile', {
    method: 'PUT',
    headers,
    body: JSON.stringify(profile)
  });
  console.log('Registered User Profile attributes (tenant, member_ref): HTTP', putProfileRes.status);

  // 2. Set attributes for all users
  const userDefs = [
    { username: 'mhs_upn', tenant: 'upnvj', member_ref: '2410511001' },
    { username: 'petugas_upn', tenant: 'upnvj', member_ref: 'STF-UPN-01' },
    { username: 'admin_upn', tenant: 'upnvj', member_ref: 'ADM-UPN-01' },
    { username: 'mhs_poltek', tenant: 'poltek', member_ref: '2420511002' },
    { username: 'petugas_poltek', tenant: 'poltek', member_ref: 'STF-POL-01' },
    { username: 'admin_poltek', tenant: 'poltek', member_ref: 'ADM-POL-01' }
  ];

  for (const def of userDefs) {
    const list = await (await fetch(`http://localhost:8081/admin/realms/cloudlib/users?username=${def.username}`, { headers })).json();
    if (list.length > 0) {
      const u = list[0];
      u.attributes = {
        tenant: [def.tenant],
        member_ref: [def.member_ref]
      };
      const res = await fetch(`http://localhost:8081/admin/realms/cloudlib/users/${u.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(u)
      });
      console.log(`Updated attributes for ${def.username}: HTTP ${res.status}`);
    }
  }

  // 3. Test token generation
  const tokenRes = await fetch('http://localhost:8081/realms/cloudlib/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: 'cloudlib-frontend',
      grant_type: 'password',
      username: 'mhs_upn',
      password: 'mhs123'
    })
  });
  const data = await tokenRes.json();
  const payload = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64').toString('utf8'));
  console.log('Verified JWT Claims:', {
    tenant: payload.tenant,
    member_ref: payload.member_ref,
    roles: payload.realm_access?.roles
  });

  // 4. Test Quarkus API call with this verified token!
  const apiRes = await fetch('http://localhost:8080/books', {
    headers: {
      Authorization: 'Bearer ' + data.access_token,
      'X-Tenant': 'upnvj',
      Accept: 'application/json'
    }
  });
  console.log('Quarkus GET /books HTTP status:', apiRes.status);
  const books = await apiRes.json();
  console.log('Quarkus Books Count:', Array.isArray(books) ? books.length : books);
}

setup().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
