# Milestone 2 Evidence Report: Application MVP
**Project**: CloudLib (Campus Library Information System with Multi-Tenancy Architecture)
**Track**: Campus Services
**Kelompok**: 6 (Kelas B, UPN Veteran Jakarta)
**Timestamp**: 2026-11-12T20:45:00+07:00
**Status**: Core workflows and persistence implemented; role-aware authorization remains incomplete

---

## 1. Ringkasan Eksekutif Milestone 2
Milestone 2 membuktikan bahwa proses bisnis inti perpustakaan telah berhasil diimplementasikan, persisten ke basis data relasional (PostgreSQL), mendukung multi-tenancy dengan isolasi data, dan memiliki proteksi terhadap anomali data (seperti double-borrowing buku dan double-booking fasilitas komputer) sebelum kompleksitas infrastruktur ditambahkan. Sesuai gate M2, authorization berbasis role (3-5 role/grup izin) belum diimplementasikan; karena itu gate M2 belum dapat dinyatakan lulus penuh.

---

## 2. Tabel Bukti Formal (Evidence Register) Sesuai Standar Pedoman Capstone

| Evidence ID | Scope | Owner | Source / Version | Method | Observation | Interpretation | Limitation | Decision Supported |
|---|---|---|---|---|---|---|---|---|
| **EVD-M2-01** | Sirkulasi Peminjaman Buku | Kelompok 6 | `LoanResource.java` v1.0.0 | HTTP POST `/loans` dengan payload `{ "barcode": "BARCODE-001", "memberRef": "member-001" }` | Response HTTP 201 Created, mengembalikan `loanId`, tanggal peminjaman, dan `dueAt` (+14 hari). Status eksemplar berubah menjadi `UNAVAILABLE`. | Transaksi peminjaman buku berhasil disimpan secara atomik dan konsistensi status terjamin. | Belum memperhitungkan denda keterlambatan (fitur lanjutan). | Memvalidasi alur bisnis peminjaman (ADR-002). |
| **EVD-M2-02** | Proteksi Peminjaman Ganda (QS03) | Kelompok 6 | `LoanResource.java`, Index `uq_loan_active_copy` | HTTP POST `/loans` berturut-turut pada eksemplar yang sama | Response HTTP 409 Conflict dengan pesan `"eksemplar sedang tidak tersedia atau sedang dipinjam"`. | Sistem menolak peminjaman kedua pada eksemplar yang sedang dipinjam berkat pessimistic write lock dan partial unique index. | Hanya menguji level API & constraint DB tunggal. | Memvalidasi Quality Scenario QS03 & ADR-002. |
| **EVD-M2-03** | Sirkulasi Pengembalian Buku | Kelompok 6 | `LoanResource.java` | HTTP POST `/loans/return` dengan `{ "barcode": "BARCODE-001" }` | Response HTTP 200 OK, `returnedAt` terisi timestamp sekarang, status eksemplar kembali `AVAILABLE`. | Buku berhasil dikembalikan dan langsung tersedia untuk dipinjam kembali. | Pengembalian ulang langsung menghasilkan 409 Conflict. | Memvalidasi siklus penuh sirkulasi buku. |
| **EVD-M2-04** | Pencegahan Double-Booking Komputer (QS02) | Kelompok 6 | `ComputerResource.java`, Constraint `uq_reservation_slot` | Dua permintaan paralel reservasi untuk komputer dan slot waktu yang sama | Hanya satu permintaan menghasilkan HTTP 201 Created; permintaan lainnya menghasilkan HTTP 409 Conflict. Baris komputer dikunci selama pemeriksaan dan penyimpanan reservasi. | Sistem secara deterministik mencegah konflik jadwal penggunaan komputer. | Reservasi menggunakan slot waktu mulai yang sama sebagai kunci konflik; durasi slot belum dimodelkan. | Memvalidasi Quality Scenario QS02 & ADR-002. |
| **EVD-M2-05** | Isolasi Multi-Tenant (QS09) | Kelompok 6 | `TenantIsolationTest.java`, Header `X-Tenant` | Tenant B (`poltek`) mencoba meminjam eksemplar milik Tenant A (`upnvj`) | Response HTTP 404 Not Found (`"eksemplar tidak ditemukan pada tenant ini"`). | Eksemplar Tenant A tidak bocor atau dapat dieksekusi oleh penyewa lain. | Isolasi diuji di level query aplikasi (ADR-012); RLS disiapkan sebagai defense-in-depth (ADR-013). | Memenuhi kewajiban wajib Multi-Tenancy Capstone. |
| **EVD-M2-06** | Ringkasan Operasional / Reporting | Kelompok 6 | `DashboardResource.java` | HTTP GET `/dashboard/summary` dengan header `X-Tenant: upnvj` | Response HTTP 200 OK dengan metrik: `totalBooks`, `totalCopies`, `availableCopies`, `activeLoans`, `totalReservations`, `totalVisitors`. | Admin perpustakaan dapat memantau ringkasan operasional secara instan per tenant. | Agregasi dihitung on-the-fly dari basis data. | Memenuhi dimensi reporting pada Application Scope. |

---

## 3. Gap M2 yang Masih Terbuka

Panduan capstone menetapkan role-aware behavior dan sekitar 3-5 role/permission groups sebagai baseline. Saat ini API hanya melakukan isolasi berdasarkan `X-Tenant`; belum ada autentikasi pengguna maupun authorization role. Jangan menganggap perilaku tenant tersebut sebagai pengganti kontrol akses berbasis role.

## 4. Hasil Eksekusi Otomatisasi Pengujian (Automated Test Run)

```text
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running id.ac.upnvj.cloudlib.CirculationTest
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0
[INFO] Running id.ac.upnvj.cloudlib.ComputerReservationTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0
[INFO] Running id.ac.upnvj.cloudlib.TenantIsolationTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0
[INFO] Running id.ac.upnvj.cloudlib.DashboardSummaryTest
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] Results:
[INFO]
[INFO] Tests run: 11, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
```

---

## 5. Log Perubahan Artefak Terverifikasi
* `src/main/java/id/ac/upnvj/cloudlib/Book.java` (Entitas Buku)
* `src/main/java/id/ac/upnvj/cloudlib/BookCopy.java` (Entitas Eksemplar)
* `src/main/java/id/ac/upnvj/cloudlib/Loan.java` (Entitas Peminjaman)
* `src/main/java/id/ac/upnvj/cloudlib/Computer.java` (Entitas Fasilitas Komputer)
* `src/main/java/id/ac/upnvj/cloudlib/ComputerReservation.java` (Entitas Reservasi Slot Komputer)
* `src/main/java/id/ac/upnvj/cloudlib/VisitorLog.java` (Entitas Presensi Pengunjung)
* `src/main/java/id/ac/upnvj/cloudlib/BookResource.java` (REST Katalog & Eksemplar)
* `src/main/java/id/ac/upnvj/cloudlib/LoanResource.java` (REST Sirkulasi Peminjaman & Pengembalian)
* `src/main/java/id/ac/upnvj/cloudlib/ComputerResource.java` (REST Komputer & Reservasi)
* `src/main/java/id/ac/upnvj/cloudlib/AttendanceResource.java` (REST Presensi Kehadiran)
* `src/main/java/id/ac/upnvj/cloudlib/DashboardResource.java` (REST Ringkasan Operasional)
* `src/main/resources/db/migration/V1__init.sql` & `V2__visitor_log_and_seed.sql` (Flyway Migrations)
