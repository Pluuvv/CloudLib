# Setup M7 pada laptop anggota tim

Panduan ini hanya mencakup pekerjaan M7: backup terenkripsi, jadwal Windows, recovery terisolasi, worker, pengujian, dan monitoring. Lab Docker/Gitea/PostgreSQL/Keycloak, Kubernetes, Argo CD, dan baseline aplikasi M6 harus sudah tersedia mengikuti setup tim. Semua perintah dijalankan dari root **repo aplikasi CloudLib**, bukan root repo infrastruktur.

## Skrip dan konfigurasi yang sudah tersedia

| Kebutuhan M7 | Entry point | Keterangan |
| --- | --- | --- |
| Membuat task backup rutin | `scripts/Install-CloudLibBackupTask.ps1` | Mendaftarkan task Windows setiap 20.00 WIB. |
| Menjalankan backup dari task | `scripts/Invoke-CloudLibBackup.ps1` | Dipanggil scheduler; meneruskan exit code dan menyimpan log yang disanitasi. |
| Backup, enkripsi, verifikasi, retensi | `reliability/backup.mjs` | `create`, `daily`, `health`, `list`, `inspect`, `verify`, `restore`; digunakan oleh scheduler dan worker yang sama. |
| PostgreSQL/app/worker recovery | `reliability/compose.yaml` | Project dan volume recovery terpisah dari lab utama. |
| Menyalin database bisnis | `reliability/baseline.mjs` | `clone` hanya menerima database recovery kosong; sumber utama dibaca saja. |
| Provisioning hak akses worker | `reliability/provision-worker.sql` | Dijalankan oleh owner hanya di server recovery yang sudah diverifikasi. Password diberikan melalui kanal privat. |
| Realm/akun uji pada lab baru | `reliability/provision-keycloak.mjs` | Khusus realm `cloudlib` yang belum ada. Jangan jalankan ulang untuk mengganti realm aktif; pada realm existing, siapkan akun/claim uji melalui admin IAM. |
| Membuat A / snapshot / B untuk drill | `reliability/recovery-checkpoint.mjs` | `prepare-a`, backup `create`, lalu `seal-b`; hanya menulis transaksi pada recovery. |
| Menguji pemulihan | `scripts/recovery-test.ps1` | `-DryRun` memeriksa prasyarat; run biasa menyuntikkan gangguan dan mengamati worker. |
| Menyajikan metrik hasil | `reliability/recovery-observer.mjs` | Endpoint loopback untuk Prometheus. |
| Memasang dashboard dan anotasi | `scripts/Publish-RecoveryDashboard.ps1` | Menggunakan Grafana yang sudah ada dan hasil injeksi aktual. |

Setup lainnya sudah memiliki entry point di atas. Konfigurasi perangkat, password, kunci dekripsi, identitas PostgreSQL dan digest image tetap diisi/diverifikasi per laptop; jangan menyalin konfigurasi privat atau kunci laptop lain lewat Git. Tidak ada skrip M7 yang mereset lab utama atau memperbaiki Docker/WSL.

## Persiapan konfigurasi privat

Prasyarat tambahan M7: Windows PowerShell, Node.js 22+, PostgreSQL 17 client tools, `age`/`age-keygen`, dan `tar`. Docker dan `kubectl` berasal dari lab sebelumnya. Pastikan seluruh program tersedia untuk akun Windows yang akan menjalankan task.

Untuk checkout baru saja:

```powershell
New-Item -ItemType Directory -Force reliability/.runtime/backup | Out-Null
Copy-Item -LiteralPath reliability/m7.env.example -Destination reliability/.runtime/.env
Copy-Item -LiteralPath reliability/backup.config.example.json -Destination reliability/.runtime/backup/config.json
```

Jangan menimpa file privat yang sudah berisi konfigurasi. Lengkapi `.env` dan JSON tersebut sebelum memasang task:

- `backupDir`: path absolut ke folder `backups` pada checkout ini; `runtimeDir`: direktori kerja privat di `.runtime`, di luar `backups`.
- `source`: database bisnis utama yang sudah ada, user-nya, dan `passwordEnv: CLOUDLIB_SOURCE_PASSWORD`. Alamat host/port harus dapat dicapai dari program client yang dipilih. Jika memakai Docker exec, gunakan prefix tool yang dijelaskan pada [panduan recovery](README.md#local-encrypted-backup-cli-formatversion-1).
- `tools`: path program yang terpasang pada laptop ini; jangan menggunakan path privat laptop anggota lain.
- `app.image` dan `app.commit`: versi yang benar-benar berjalan dan telah disetujui pipeline.
- `encryption.identityFile` dan `recipient`: kunci age lokal beserta public recipient yang sesuai. Buat dengan `age-keygen -o <path-kunci-privat>` lalu baca recipient dengan `age-keygen -y <path-kunci-privat>`. Kunci tidak masuk Git.
- Field `recovery` tetap diperlukan oleh kontrak JSON bersama. Isi identitas server recovery yang sudah diverifikasi, role, dan allowlist kandidat; jangan memakai identitas server utama.

Batasi ACL direktori konfigurasi/kunci pada akun operator dan SYSTEM sesuai [panduan izin](README.md#local-encrypted-backup-cli-formatversion-1). File yang sudah diisi, arsip `.age`, dan metadata runtime tetap lokal/ignored. Template `.example` boleh dibagikan.

## Memasang backup rutin

Gunakan nama/path konfigurasi yang Anda siapkan pada laptop tersebut:

```powershell
$config = (Resolve-Path reliability/.runtime/backup/config.json).Path
$privateEnv = (Resolve-Path reliability/.runtime/.env).Path

# Uji backup terlebih dahulu: harus exit 0 dan status ok.
node --env-file=$privateEnv reliability/backup.mjs daily --config $config
if ($LASTEXITCODE -ne 0) { throw 'Backup belum berhasil; perbaiki konfigurasi sebelum memasang task.' }

# Buat task Windows. Tidak perlu membuat XML manual.
.\scripts\Install-CloudLibBackupTask.ps1 -ConfigPath $config -EnvFile $privateEnv
```

Hasilnya task `CloudLib-DailyLocalBackup`, setiap hari **20.00 WIB**, dengan `StartWhenAvailable`, `WakeToRun`, dan pencegahan eksekusi tumpang-tindih. Definisi XML otomatis disimpan sebagai `backup-task.xml` di sebelah konfigurasi privat. `-XmlPath` tetap tersedia jika membutuhkan lokasi lain. Password tidak ditulis ke XML; task hanya menyimpan path env-file dan membaca isinya saat berjalan.

Jika `source.passwordEnv` digunakan, installer memeriksa bahwa env-file diberikan dan berisi variabel tersebut dengan nilai tidak kosong. Installer menolak task dengan nama yang sudah ada, sehingga tidak mengganti task milik orang lain maupun memasang ulang task operasional secara diam-diam.

Untuk memeriksa XML tanpa mendaftarkan task:

```powershell
.\scripts\Install-CloudLibBackupTask.ps1 -ConfigPath $config -EnvFile $privateEnv -DefinitionOnly
```

Untuk menguji task yang telah terpasang:

```powershell
Start-ScheduledTask -TaskName CloudLib-DailyLocalBackup
Get-ScheduledTask -TaskName CloudLib-DailyLocalBackup
# Tunggu State kembali Ready, lalu periksa hasil terbaru.
Get-ScheduledTaskInfo -TaskName CloudLib-DailyLocalBackup
```

`LastTaskResult` harus **0** dan `LastRunTime` harus sesuai pengujian yang baru dilakukan. Periksa pula `backup-status.json` dan baris terbaru `backup-runs.jsonl` di `backupDir`: `lastAttempt.status=ok`, snapshot baru terverifikasi, dan `rpoMet=true`. Status Ready saja tidak membuktikan backup berhasil.

Task memakai akun Windows yang sedang login dengan hak biasa dan tanpa menyimpan password Windows. Laptop harus menyala, pengguna login, Docker/DB tersedia, serta file konfigurasi/kunci dapat dibaca akun itu. Jadwal terlewat dapat diproses Windows melalui `StartWhenAvailable`; laptop mati tidak dapat menjalankan backup. Retensi tujuh hari dijalankan oleh CLI `daily`, bukan task terpisah. Tidak ada task terjadwal untuk menghapus database atau menjalankan recovery-test.

## Setup recovery dan monitoring

Untuk backup rutin pada lab yang sudah dikonfigurasi, instalasi task di atas sudah cukup. Untuk menjalankan keseluruhan demo M7 pada laptop baru, ikuti entry point existing berikut secara berurutan:

1. Siapkan secret dan image digest di `.env`, identitas OIDC/akun uji, serta izin file privat. Jangan mengimpor ulang realm yang sudah ada.
2. Jalankan service PostgreSQL recovery dari Compose. Verifikasi project `cloudlib-recovery`, network `cloudlib-recovery-net`, volume `cloudlib-recovery-pgdata`, PostgreSQL 17 dan system identifier-nya.
3. Gunakan `baseline.mjs clone cloudlib-recovery-postgres` hanya saat database recovery kosong. Provision role worker menggunakan SQL existing dan beri password privat yang sesuai.
4. Isi template `worker.config.example.json` dan konfigurasi backup host/container. Pisahkan backup utama (`backups/`) dari snapshot drill (`backups/recovery/`); worker menggunakan folder backup read-only dan tidak memakai Docker socket. Lihat [alur worker](README.md#independent-recovery-worker-formatversion-1).
5. Jalankan app dan worker dari Compose; verifikasi login nyata dan baseline. Siapkan konfigurasi QS05/QS06 sesuai identitas laptop, lalu A/snapshot/B melalui preparer. Konfigurasi `resultFile` terpisah per metode dan `latestResultFile` bersama dipakai untuk monitoring.
6. Jalankan observer pada loopback 19090. Konfigurasi Prometheus repo infrastruktur sudah memuat job `cloudlib-recovery-drill`; verifikasi target UP. Setelah ada hasil injeksi nyata, pasang dashboard/anotasi melalui publisher.

Perintah detail dan batas keselamatan tiap tahap tersedia pada [README recovery](README.md) dan [panduan demo M7](../docs/evidence/M7/M7-Evidence-Reliability-Recovery.md). Skrip yang menyuntikkan gangguan dijalankan secara sadar oleh operator, terpisah dari pemasangan task backup.
