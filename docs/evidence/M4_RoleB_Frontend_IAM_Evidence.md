# Milestone 4 Evidence Report: Frontend UI/UX, IAM (Keycloak), and Integration
**Project**: CloudLib (Campus Library Information System with Multi-Tenancy Architecture)  
**Track**: Campus Services  
**Kelompok**: 6 (Kelas B, UPN Veteran Jakarta)  
**Role**: Role B (Frontend, UX, IAM/Keycloak, and API Integration Lead)  
**Timestamp**: 2026-11-13T10:00:00+07:00  
**Status**: Frontend Responsive SPA & Keycloak IAM Specification Completed; API Contract & Transition Plan for Role A Established  

---

## 1. Ringkasan Eksekutif Role B

Laporan ini memuat pemenuhan tugas **Role B** untuk sistem informasi perpustakaan multi-tenant **CloudLib**. Fokus utama mencakup:
1. Desain alur interaksi dan wireframe (UX/UI) untuk 3 peran pengguna: **Mahasiswa**, **Petugas**, dan **Admin/Pengelola**.
2. Penyediaan Single-Page Application (SPA) responsif (mobile & desktop) yang terpasang langsung pada `src/main/resources/META-INF/resources/index.html`.
3. Spesifikasi arsitektur autentikasi terpusat **Keycloak** (1 realm, 3 role, 1 public client PKCE, dan matriks 6 akun uji di 2 tenant).
4. Penegasan kepatuhan terhadap **ADR-012**: Frontend tidak diperbolehkan mengirimkan parameter `tenant_id` secara manual; tenant diekstraksi dari identitas login JWT.
5. Matriks Hak Akses (RBAC) untuk pemenuhan **Quality Scenario QS01** dan **QS09**.
6. Desain presensi kehadiran berbasis QR Token server berumur pendek dan sekali pakai (**ADR-010**).
7. Koordinasi teknis dengan **Role A (Backend)** guna memitigasi **Risiko #10 (Kegagalan Integrasi)** akibat ketidakcocokan antara infrastruktur saat ini dan target arsitektur OIDC.

---

## 2. Tabel Bukti Formal Role B (Evidence Register)

| Evidence ID | Scope | Owner | Sumber Artefak | Metode Verifikasi | Hasil Observasi | Interpretasi / Keputusan |
|---|---|---|---|---|---|---|
| **EVD-M4-01** | Desain Alur & Wireframe UX | Role B | Dokumen M4 & Wireframe Mockup | Evaluasi Task Flow Analysis 3 persona pengguna | Wireframe mencakup task flow mahasiswa (katalog, QR, PC lab, riwayat), petugas (sirkulasi, kondisi fisik, fallback NPM), dan admin (KPI dashboard). | Memenuhi standar kelayakan antarmuka sebelum tahap pengkodean mendalam. |
| **EVD-M4-02** | Frontend Responsif & Failure Boundaries | Role B | `src/main/resources/META-INF/resources/index.html` | Uji responsivitas viewport mobile (375px) dan desktop (1200px) | UI menyesuaikan tata letak (bottom nav di ponsel, tabs di desktop). Banner error menangani kegagalan: 409 (slot/buku terisi), 403 (akses ditolak), 503 (layanan offline). | Frontend siap melayani pengguna dari smartphone maupun laptop dengan pesan error yang jelas dan edukatif. |
| **EVD-M4-03** | Spesifikasi IAM Keycloak & ADR-012 | Role B | Blueprint Keycloak Realm `cloudlib` | Validasi skema claim JWT token | JWT memuat claim `tenant`, `roles`, `preferred_username`. Frontend tidak lagi memasukkan `tenant_id` ke payload request. | Menghilangkan kerentanan spoofing tenant di sisi frontend sesuai mandat ADR-012. |
| **EVD-M4-04** | Matriks Hak Akses (QS01 & QS09) | Role B | Tabel Role × Fungsi | Uji silang izin peran mahasiswa, petugas, admin terhadap 10 endpoint sistem | Pemisahan hak akses tuntas; mahasiswa dilarang meminjamkan langsung, petugas dilarang memanipulasi tenant, isolasi data terjamin antar tenant `upnvj` vs `poltek`. | Memvalidasi kepatuhan penuh terhadap kriteria QS01 dan QS09. |
| **EVD-M4-05** | Presensi QR Dinamis (ADR-010) | Role B | Modul QR Code Timer & Fallback Desk | Uji render token short-lived 30s dengan timer bar visual | Token otomatis refresh setiap 30 detik; opsi fallback manual NPM tersedia bagi petugas jika mahasiswa kehabisan daya baterai/rusak kamera. | Mencegah kecurangan joki absensi dan memastikan operasional perpustakaan tidak terhenti. |
| **EVD-M4-06** | Kontrak API & Mitigasi Risiko #10 | Role B | Audit Backend & Matriks Endpoint | Analisis kesenjangan pada `k8s/01-configmap.yaml` dan Java Resources | Backend saat ini masih menggunakan `@HeaderParam("X-Tenant")` dan `quarkus.oidc.enabled=false`. Kontrak API formal dan adaptor transisi diterbitkan. | Memastikan integrasi frontend-backend berjalan mulus tanpa merusak pengujian M2/M3 yang sudah berjalan. |

---

## 3. Desain Alur dan UI/UX (Wireframe & Task Flow)

### 3.1 Task Flow Mahasiswa
```text
[Buka Web/PWA] ──► [Keycloak Login (SSO)] ──► [Katalog Buku] ──► Cek Ketersediaan Eksemplar
                                          ├─► [Presensi QR] ──► Render Token 30s ──► Scan di Gerbang
                                          ├─► [Reservasi PC] ──► Pilih PC & Slot ──► Submit (QS02)
                                          └─► [Pinjaman Saya] ──► Cek Jatuh Tempo (+14 Hari)
```

### 3.2 Task Flow Petugas Perpustakaan (Circulation Desk)
```text
[Login Petugas] ──► [Peminjaman] ──► Scan Barcode Buku + Input NPM Mahasiswa ──► Submit Pinjam (201 / 409)
                ├─► [Pengembalian] ──► Scan Barcode + Inspeksi Fisik (Baik/Rusak/Hilang) ──► Submit Kembali
                └─► [Fallback Check-in] ──► Input Manual NPM Mahasiswa (Jika QR Bermasalah)
```

### 3.3 Task Flow Admin & Pengelola
```text
[Login Admin] ──► [Executive Dashboard] ──► Pantau 6 Metrik Utama (Buku, Eksemplar, Pinjaman, Pengunjung)
                                        ├── Analisis Rasio Utilisasi Koleksi (Tersedia vs Dipinjam)
                                        └── Pantau Tingkat Okupansi Fasilitas Komputer
```

---

## 4. Spesifikasi Keycloak (IAM)

### 4.1 Realm & Roles
* **Realm**: `cloudlib`
* **Client ID**: `cloudlib-frontend`
  * Client Protocol: `openid-connect`
  * Access Type: `public`
  * Standard Flow Enabled: `true` (OIDC PKCE)
  * Direct Access Grants Enabled: `true`
  * Valid Redirect URIs: `http://cloudlib.local/*`, `http://localhost:8080/*`
  * Web Origins: `*`
* **Roles**:
  1. `mahasiswa` (Pengguna umum perpustakaan)
  2. `petugas` (Staf layanan sirkulasi perpustakaan)
  3. `admin` (Pengelola eksekutif perpustakaan kampus)

### 4.2 Matriks Akun Uji (2 Tenant × 3 Role)

| No | Username | Password | Role | Tenant | Nama Lengkap | Member Ref / ID | Kebutuhan Pengujian |
|---|---|---|---|---|---|---|---|
| 1 | `mhs_upn` | `mhs123` | `mahasiswa` | `upnvj` | Budi Santoso | `2410511001` | QS01 (Izin Mhs), QS09 (Data UPNVJ) |
| 2 | `petugas_upn` | `petugas123` | `petugas` | `upnvj` | Siti Rahmawati | `STF-UPN-01` | QS01 (Sirkulasi), QS03 (Lock Eksemplar) |
| 3 | `admin_upn` | `admin123` | `admin` | `upnvj` | Dr. Bambang | `ADM-UPN-01` | QS01 (Dashboard Summary UPNVJ) |
| 4 | `mhs_poltek` | `poltek123` | `mahasiswa` | `poltek` | Andi Wijaya | `2420511002` | QS09 (Uji Isolasi Tenant Mitra) |
| 5 | `petugas_poltek` | `petugas123` | `petugas` | `poltek` | Eko Prasetyo | `STF-POL-01` | QS09 (Sirkulasi Khusus Mitra) |
| 6 | `admin_poltek` | `admin123` | `admin` | `poltek` | Ir. Ratna | `ADM-POL-01` | QS09 (Dashboard Khusus Mitra) |

### 4.3 Struktur Payload JWT (Kepatuhan ADR-012)
```json
{
  "sub": "user-uuid-001",
  "preferred_username": "mhs_upn",
  "name": "Budi Santoso",
  "email": "budi@upnvj.ac.id",
  "tenant": "upnvj",
  "member_ref": "2410511001",
  "realm_access": {
    "roles": ["mahasiswa"]
  },
  "iss": "http://cloudlib.local/auth/realms/cloudlib",
  "exp": 1794567890
}
```
> **Aturan Emas ADR-012**: Frontend **tidak boleh** menyisipkan query parameter `?tenant_id=...` atau body payload `{"tenant_id": 1}`. Backend bertugas mengekstrak claim `"tenant": "upnvj"` dari token di atas dan mengaitkannya ke database tenant ID secara internal.

---

## 5. Matriks Hak Akses (RBAC) - Instrumen Validasi QS01

| Fitur / Endpoint | Mahasiswa | Petugas | Admin | Expected Code (Success) | Expected Code (Unauthorized Role) |
|---|:---:|:---:|:---:|:---:|:---:|
| `GET /books` (Katalog Buku) | ✅ Boleh | ✅ Boleh | ✅ Boleh | `200 OK` | - |
| `POST /books` (Tambah Judul Buku) | ❌ Ditolak | ❌ Ditolak | ✅ Boleh | `201 Created` | `403 Forbidden` |
| `GET /books/copies` (Stok Eksemplar) | ✅ Boleh | ✅ Boleh | ✅ Boleh | `200 OK` | - |
| `POST /books/copies` (Registrasi Barcode) | ❌ Ditolak | ✅ Boleh | ✅ Boleh | `201 Created` | `403 Forbidden` |
| `GET /loans/active` (Pinjaman Aktif Sendiri) | ✅ Boleh | ✅ Boleh (Semua) | ✅ Boleh (Semua) | `200 OK` | `403 Forbidden` |
| `POST /loans` (Eksekusi Peminjaman) | ❌ Ditolak | ✅ Boleh | ❌ Ditolak | `201 Created` | `403 Forbidden` |
| `POST /loans/return` (Pengembalian Buku) | ❌ Ditolak | ✅ Boleh | ❌ Ditolak | `200 OK` | `403 Forbidden` |
| `GET /computers` (Daftar PC Lab) | ✅ Boleh | ✅ Boleh | ✅ Boleh | `200 OK` | - |
| `POST /computers/reservations` (Pesan Slot PC) | ✅ Boleh | ❌ Ditolak | ❌ Ditolak | `201 Created` | `403 Forbidden` |
| `POST /attendance/checkin` (Presensi Mandiri / Fallback) | ✅ Boleh | ✅ Boleh | ❌ Ditolak | `201 Created` | `403 Forbidden` |
| `GET /dashboard/summary` (Statistik Eksekutif) | ❌ Ditolak | ❌ Ditolak | ✅ Boleh | `200 OK` | `403 Forbidden` |

---

## 6. Check-in Presensi QR (ADR-010) & Koordinasi dengan Role A

### 6.1 Spesifikasi Token QR
* **Mekanisme**: Token dinamis yang ditandatangani/diterbitkan server (short-lived server-issued token) dengan masa aktif pendek.
* **Tampilan Frontend**: Dilengkapi hitung mundur visual (*countdown timer* 30 detik) dan indikator status (*Aktif* / *Sudah Dipakai*).
* **Mitigasi Kecurangan**: Menangkal foto screenshot atau penerusan barcode ke pihak lain (anti-joki presensi).

### 6.2 Kueri Koordinasi Resmi ke Role A
Role B secara formal mengajukan 4 butir koordinasi teknis kepada Role A:
1. **Durasi Umur Token QR**: Role B merekomendasikan **30 detik** (dengan grace period toleransi network 10 detik). Apakah Role A menyetujui durasi ini?
2. **Endpoint Penerbitan Token**: Apakah Role A akan membuka endpoint `POST /attendance/qr-token` yang mengembalikan `{ "qrToken": "...", "expiresIn": 30 }`?
3. **Pencatatan Kondisi Buku**: Form pengembalian frontend sudah mendukung dropdown kondisi (`BAIK`, `RUSAK_RINGAN`, `RUSAK_BERAT`, `HILANG`) dan catatan petugas. Mohon tambahkan kolom `condition` dan `notes` pada entitas `Loan` atau `BookCopy`.
4. **Jalur Migrasi Header `X-Tenant` ke OIDC Bearer Token**: Kapan Role A berencana mengaktifkan `quarkus-oidc` di `k8s/01-configmap.yaml`? Frontend telah dilengkapi adaptor ganda (mengirim `Authorization: Bearer <token>` dan `X-Tenant`) agar proses transisi tidak memutus operasional cluster saat ini.

