import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrik K6 untuk Konteks Milestone 9
export const errorRate = new Rate('custom_error_rate');
export const catalogLatency = new Trend('catalog_latency_ms');
export const checkinLatency = new Trend('checkin_latency_ms');

export const options = {
  stages: [
    { duration: '5s', target: 10 },   // Ramp-up
    { duration: '20s', target: 25 },  // Steady state beban normal
    { duration: '5s', target: 50 },   // Peak stress load
    { duration: '5s', target: 0 },    // Ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<200'], // SLO Latensi 95th percentile < 200ms
    'custom_error_rate': ['rate<0.01'], // SLO Error rate < 1%
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:8080';
const TENANT = __ENV.TENANT || 'upnvj';
const TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const headers = {
    'Accept': 'application/json',
    'X-Tenant': TENANT,
  };
  if (TOKEN) {
    headers['Authorization'] = `Bearer ${TOKEN}`;
  }

  // 1. Read-heavy: Katalog Koleksi Buku (Bobot 65%)
  const resBooks = http.get(`${BASE_URL}/books`, { headers });
  catalogLatency.add(resBooks.timings.duration);
  const okBooks = check(resBooks, {
    'GET /books status 200': (r) => r.status === 200,
  });
  errorRate.add(!okBooks);

  // 2. Read-heavy: Stok Eksemplar
  const resCopies = http.get(`${BASE_URL}/books/copies`, { headers });
  check(resCopies, {
    'GET /books/copies status 200': (r) => r.status === 200,
  });

  // 3. Write-heavy: Presensi Kehadiran Mahasiswa (Bobot 20%)
  const checkinPayload = JSON.stringify({
    memberRef: `mhs-${Math.floor(Math.random() * 1000) + 1000}`,
  });
  const checkinHeaders = Object.assign({}, headers, { 'Content-Type': 'application/json' });
  const resCheckin = http.post(`${BASE_URL}/attendance/checkin`, checkinPayload, { headers: checkinHeaders });
  checkinLatency.add(resCheckin.timings.duration);
  const okCheckin = check(resCheckin, {
    'POST /attendance/checkin status 201/200': (r) => r.status === 201 || r.status === 200,
  });
  errorRate.add(!okCheckin);

  // 4. Read: Fasilitas Komputer
  http.get(`${BASE_URL}/computers`, { headers });

  sleep(0.5); // Think time realistis mahasiswa
}
