#!/usr/bin/env node
/**
 * CloudLib Milestone 9 - Capacity & Load Testing Suite
 * Track: Campus Services | Kelompok: 6 (Kelas B, UPN Veteran Jakarta)
 * 
 * Menguji throughput (RPS), latensi (p50, p90, p95, p99), error rate,
 * dan kapasitas tersisa (headroom) sesuai konteks bisnis perpustakaan CloudLib.
 */

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  return fallback;
}

const BASE_URL = getArg('--target', process.env.CLOUDLIB_URL || 'http://localhost:8080');
const CONCURRENCY = parseInt(getArg('--vus', getArg('-c', '25')), 10);
const DURATION_SEC = parseInt(getArg('--duration', getArg('-d', '30')), 10);
const TENANT_CODE = getArg('--tenant', 'upnvj');
let AUTH_TOKEN = getArg('--token', process.env.CLOUDLIB_TOKEN || '');
const KEYCLOAK_URL = getArg('--keycloak', process.env.KEYCLOAK_URL || 'http://localhost:8081');
const OUT_FILE = getArg('--out', 'docs/evidence/M9/capacity-metrics.json');

// Skenario Beban Relevan Konteks CloudLib
// Distribusi: 65% Katalog (Read-heavy), 20% Presensi Kehadiran (Write), 10% Sirkulasi/Fasilitas, 5% Dashboard Admin
const SCENARIOS = [
  {
    name: 'Katalog Buku',
    weight: 35,
    method: 'GET',
    path: '/books',
    body: null
  },
  {
    name: 'Stok Eksemplar',
    weight: 30,
    method: 'GET',
    path: '/books/copies',
    body: null
  },
  {
    name: 'Presensi Check-in',
    weight: 20,
    method: 'POST',
    path: '/attendance/checkin',
    getBody: () => ({ memberRef: `mhs-${Math.floor(Math.random() * 1000) + 1000}` })
  },
  {
    name: 'Fasilitas Komputer',
    weight: 10,
    method: 'GET',
    path: '/computers',
    body: null
  },
  {
    name: 'Pinjaman Aktif',
    weight: 5,
    method: 'GET',
    path: '/loans/active',
    body: null
  }
];

function pickScenario() {
  const totalWeight = SCENARIOS.reduce((sum, s) => sum + s.weight, 0);
  let random = Math.random() * totalWeight;
  for (const scenario of SCENARIOS) {
    if (random < scenario.weight) return scenario;
    random -= scenario.weight;
  }
  return SCENARIOS[0];
}

// Data Collector
const latencies = [];
const endpointStats = {};
SCENARIOS.forEach(s => {
  endpointStats[s.name] = { requests: 0, errors: 0, latencies: [] };
});
const statusCodes = {};
let totalRequests = 0;
let totalErrors = 0;

async function executeRequest(scenario) {
  const url = `${BASE_URL}${scenario.path}`;
  const headers = {
    'Accept': 'application/json',
    'X-Tenant': TENANT_CODE
  };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  let body = null;
  if (scenario.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(scenario.getBody ? scenario.getBody() : scenario.body);
  }

  const start = performance.now();
  totalRequests++;
  endpointStats[scenario.name].requests++;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: scenario.method,
      headers,
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);

    const duration = performance.now() - start;
    latencies.push(duration);
    endpointStats[scenario.name].latencies.push(duration);

    statusCodes[res.status] = (statusCodes[res.status] || 0) + 1;

    // Anggap non-2xx sebagai error (kecuali 409 pada double action yang diharapkan)
    if (!res.ok) {
      totalErrors++;
      endpointStats[scenario.name].errors++;
    }
  } catch (err) {
    const duration = performance.now() - start;
    latencies.push(duration);
    endpointStats[scenario.name].latencies.push(duration);
    totalErrors++;
    endpointStats[scenario.name].errors++;
    statusCodes['ERR_NET'] = (statusCodes['ERR_NET'] || 0) + 1;
  }
}

function calculatePercentiles(arr) {
  if (arr.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const getP = (p) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  };
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99)
  };
}

// Worker loop
let isRunning = true;
async function worker() {
  while (isRunning) {
    const scenario = pickScenario();
    await executeRequest(scenario);
  }
}

async function run() {
  if (!AUTH_TOKEN) {
    try {
      const tokenRes = await fetch(`${KEYCLOAK_URL}/realms/cloudlib/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'cloudlib-frontend',
          grant_type: 'password',
          username: 'mhs_upn',
          password: 'mhs123'
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (tokenRes.ok) {
        const data = await tokenRes.json();
        AUTH_TOKEN = data.access_token;
        console.log(' [IAM/OIDC] Berhasil mengautentikasi ke Keycloak sebagai: mhs_upn');
      }
    } catch (e) {
      // Keycloak unavailable or offline, continue with unauthenticated/header-based test
    }
  }

  console.log('='.repeat(70));
  console.log(' CLOUDLIB MILESTONE 9: CAPACITY & LOAD TEST BENCHMARK');
  console.log('='.repeat(70));
  console.log(` Target URL     : ${BASE_URL}`);
  console.log(` Tenant         : ${TENANT_CODE}`);
  console.log(` Virtual Users  : ${CONCURRENCY} concurrent workers`);
  console.log(` Durasi Uji     : ${DURATION_SEC} detik`);
  console.log(` Profil Beban   : Katalog (65%), Presensi (20%), Fasilitas (10%), Dashboard (5%)`);
  console.log('-'.repeat(70));
  console.log(' Menjalankan uji beban, mohon tunggu...\n');

  const startTime = performance.now();

  // Jalankan sejumlah CONCURRENCY workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker());

  // Timer countdown
  const timerPromise = new Promise((resolve) => {
    setTimeout(() => {
      isRunning = false;
      resolve();
    }, DURATION_SEC * 1000);
  });

  await timerPromise;
  await Promise.all(workers);

  const totalTimeSec = (performance.now() - startTime) / 1000;
  const overall = calculatePercentiles(latencies);
  const rps = totalRequests / totalTimeSec;
  const errorRatePct = (totalErrors / (totalRequests || 1)) * 100;

  // Cetak Hasil Tabel Utama
  console.log('='.repeat(70));
  console.log(' RINGKASAN HASIL PENGUKURAN METRIK KAPASITAS (M9)');
  console.log('='.repeat(70));
  console.log(` Total Permintaan (Requests) : ${totalRequests.toLocaleString('id-ID')} req`);
  console.log(` Total Waktu Eksekusi        : ${totalTimeSec.toFixed(2)} s`);
  console.log(` Throughput Aktual (RPS)     : ${rps.toFixed(2)} req/sec`);
  console.log(` Error Rate                  : ${errorRatePct.toFixed(2)}% (${totalErrors} gagal)`);
  console.log('-'.repeat(70));
  console.log(' STATISTIK LATENSI (RESPONS WAKTU):');
  console.log(` - Rata-rata (Avg)           : ${overall.avg.toFixed(2)} ms`);
  console.log(` - Min / Max                 : ${overall.min.toFixed(2)} ms / ${overall.max.toFixed(2)} ms`);
  console.log(` - Median (p50)              : ${overall.p50.toFixed(2)} ms`);
  console.log(` - 90th Percentile (p90)     : ${overall.p90.toFixed(2)} ms`);
  console.log(` - 95th Percentile (p95)     : ${overall.p95.toFixed(2)} ms  <-- Indikator Utama SLO`);
  console.log(` - 99th Percentile (p99)     : ${overall.p99.toFixed(2)} ms`);
  console.log('-'.repeat(70));

  console.log(' DISTRIBUSI STATUS CODE HTTP:');
  Object.keys(statusCodes).forEach(code => {
    const count = statusCodes[code];
    const pct = ((count / totalRequests) * 100).toFixed(1);
    console.log(`   HTTP ${code.padEnd(7)} : ${count.toString().padStart(6)} (${pct}%)`);
  });
  console.log('-'.repeat(70));

  console.log(' RINCIAN PERFORMA PER ENDPOINT / SKENARIO:');
  console.log(' '.padEnd(25) + 'Req'.padStart(8) + 'RPS'.padStart(10) + 'Avg(ms)'.padStart(10) + 'p95(ms)'.padStart(10) + 'Err%'.padStart(8));
  Object.keys(endpointStats).forEach(name => {
    const s = endpointStats[name];
    const p = calculatePercentiles(s.latencies);
    const sRps = (s.requests / totalTimeSec).toFixed(1);
    const errPct = ((s.errors / (s.requests || 1)) * 100).toFixed(1);
    console.log(
      name.padEnd(25) +
      s.requests.toString().padStart(8) +
      sRps.padStart(10) +
      p.avg.toFixed(1).padStart(10) +
      p.p95.toFixed(1).padStart(10) +
      `${errPct}%`.padStart(8)
    );
  });
  console.log('='.repeat(70));

  // Evaluasi Headroom & Kapasitas Tersisa (Berdasarkan Target Sizing 100 RPS Baseline)
  const BASELINE_TARGET_RPS = 100;
  const headroomPct = Math.max(0, ((BASELINE_TARGET_RPS - rps) / BASELINE_TARGET_RPS) * 100);
  console.log(' ANALISIS KAPASITAS & HEADROOM (CAPACITY PLANNING):');
  console.log(` - Beban Uji Saat Ini        : ${rps.toFixed(2)} RPS (${CONCURRENCY} concurrent users)`);
  console.log(` - Ambang Target SLO Latensi : 200.00 ms (p95)`);
  console.log(` - Status SLO Latensi        : ${overall.p95 <= 200 ? 'MEMENUHI SLO (PASS)' : 'MELEBIHI AMBANG (WARNING)'}`);
  console.log(` - Status Error Rate         : ${errorRatePct <= 1.0 ? 'MEMENUHI SLO (PASS < 1%)' : 'TINGGI (FAIL > 1%)'}`);
  console.log('='.repeat(70));

  // Simpan output ke format JSON untuk diintegrasikan ke laporan M9 & FinOps
  const reportData = {
    timestamp: new Date().toISOString(),
    config: {
      baseUrl: BASE_URL,
      tenant: TENANT_CODE,
      virtualUsers: CONCURRENCY,
      durationSeconds: DURATION_SEC
    },
    metrics: {
      totalRequests,
      totalErrors,
      errorRatePercent: errorRatePct,
      throughputRps: rps,
      latencyMs: overall,
      statusCodes,
      endpointBreakdown: endpointStats
    }
  };

  try {
    const dir = path.dirname(OUT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(reportData, null, 2), 'utf8');
    console.log(`\n Laporan metrik berhasil disimpan ke: ${OUT_FILE}`);
  } catch (e) {
    console.log(`\n Gagal menyimpan file JSON: ${e.message}`);
  }
}

run().catch(err => {
  console.error('Error saat uji kapasitas:', err);
  process.exit(1);
});
