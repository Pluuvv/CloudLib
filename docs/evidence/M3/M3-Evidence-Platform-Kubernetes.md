# Milestone 3 Evidence Report — Platform dan Kubernetes

- **Proyek** CloudLib · **Track** Campus Services · **Kelompok** 6 (Kelas B, UPN Veteran Jakarta)
- **Peran** C (Platform & Delivery) · **Tanggal uji** 13 November 2026 (WIB)
- **Status** Deploy awal dan pemulihan pod terverifikasi di lab lokal.

## 1. Ringkasan Eksekutif

CloudLib berjalan di k3d dengan PostgreSQL di Docker host. Readiness melalui Traefik mengembalikan HTTP 200. Setelah satu pod dihapus, layanan pulih dalam **27,64 detik** dan transaksi yang sudah commit tetap terbaca.

## 2. Tabel Bukti Formal (Evidence Register)

| Evidence ID | Scope | Owner | Sumber / Versi | Timestamp | Metode | Observasi | Interpretasi | Limitasi | Keputusan yang Didukung |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **EVD-M3-C-01** | Infrastruktur lokal dari Docker sampai Ingress. | C, Platform & Delivery. | Gitea `28.2.0`, runner `5.1.1`, Argo CD `3.5.6`, k3s `v1.35.5+k3s1`. Baseline aplikasi `c8e570afb91348135d48ff61e6eb43e3c7c81271` dan GitOps `a0852b64c3bda08e749ffd4cfe3d0a3661f38e6f`. | 13 November 2026, 09.38.17 WIB. | Jalankan pemeriksaan prasyarat paket dosen, periksa layanan inti dan node, lalu uji image Nginx dari registry lewat Traefik. | Doctor `READY`, runner `online`, PostgreSQL menerima koneksi, dua node `Ready`, dan Ingress smoke test HTTP 200. | Jalur Docker → registry → k3d → Traefik siap untuk deploy CloudLib. | Smoke test memakai Nginx dari paket dosen. | Gunakan lab ini untuk deploy pertama CloudLib. |
| **EVD-M3-C-02** | Deployment, Service, ConfigMap, referensi Kubernetes Secret, Ingress, probe, dan requests/limits di k3d. | C, Platform & Delivery. Dockerfile multi-stage dan endpoint health berasal dari A dan dipakai untuk validasi platform. | Perubahan manifest `981af72`, revisi GitOps yang berjalan `c43e2ac18e8bb0846a1476973d2e921870abb9a1`. SHA aplikasi dan digest image tercatat di [M4](../M4/M4-Evidence-CI-CD-GitOps.md). | 13 November 2026, 10.04.03 WIB. | Periksa Application Argo CD, image pod, dan respons readiness melalui Ingress. | Argo CD `Synced` dan `Healthy`, readiness HTTP 200, koneksi PostgreSQL `UP`. | CloudLib berjalan di k3d dengan PostgreSQL di Docker host. | Lab lokal dengan satu replika. OIDC CloudLib masih dinonaktifkan pada versi yang diuji. | Gunakan deploy ini sebagai baseline uji pemulihan dan rollback. |
| **EVD-M3-C-03** | Satu uji penghapusan pod pada Deployment satu replika. | C, Platform & Delivery. | Aplikasi `26c77567319e657cb0b8e42402ce04a4012c5c84`, GitOps `c43e2ac18e8bb0846a1476973d2e921870abb9a1`. | Penghapusan dimulai 13 November 2026, 10.38.33,627 WIB. | Commit dan baca transaksi peminjaman sintetis, hapus satu pod tanpa force, lalu probe readiness via Traefik sekitar tiap detik dengan timeout 5 detik. Baca ulang transaksi setelah pod pengganti siap. | Pod pengganti `Ready` dalam **26,37 detik**. HTTP 200 `UP` kembali dalam **27,64 detik** setelah 26 respons HTTP 503. Data transaksi ID `1` identik sebelum dan sesudah pemulihan. Pinjaman uji kemudian dikembalikan dengan HTTP 200. | Kubernetes mengganti pod dan transaksi yang sudah commit tetap dapat dibaca dari PostgreSQL. | Satu pengulangan dengan trafik probe. Ketelitian waktu mengikuti interval probe. | QS05 lulus pada uji ini terhadap target **≤120 detik**. |

## 3. Artefak dan Handoff

[Arsip bukti M3](M3-Bukti-Mentah.zip) memuat output kesiapan lab, status deploy awal, event pod, log probe, dan data transaksi sebelum serta sesudah. D dapat memakai timestamp penghapusan pod untuk korelasi dengan grafik.

Bukti mencatat konfigurasi saat pengujian. Lihat [migrasi nama ke `cloudlib-app`](../M4/M4-Evidence-CI-CD-GitOps.md#4-migrasi-nama-cloudlib-app) untuk penamaan lab saat ini.
