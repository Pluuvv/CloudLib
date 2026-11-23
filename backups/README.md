# Backup lokal CloudLib

Folder `backups/` di root repo aplikasi menyimpan backup database CloudLib untuk pengerjaan M7 sesi ini. Backup berupa arsip terenkripsi dan metadata verifikasi; recovery otomatis menggunakan backup lokal yang telah diverifikasi.

Panduan konfigurasi dan perintah backup/restore berada di [panduan reliability](../reliability/README.md). Setiap anggota tim dapat menjalankan skrip yang sama pada checkout dan lingkungan lokalnya.

Hanya README ini yang ikut Git. Arsip backup, metadata runtime, dump, dan subfolder lain di sini diabaikan Git. Memindahkan folder ke repo tidak mengunggah arsip ke teman; distribusi arsip memerlukan penyalinan terpisah melalui media tim yang disepakati. Kunci dekripsi dan kredensial tetap disimpan di konfigurasi lokal yang dilindungi, bukan di folder ini.

Penyimpanan Google Drive ditunda ke sesi berikutnya. Backup pada laptop/drive yang sama tidak menyediakan pemulihan jika perangkat atau drive tersebut hilang.

Ticket05 menambahkan `backup-status.json` (hasil percobaan, snapshot valid terakhir, usia/RPO pada waktu pemeriksaan) dan `backup-runs.jsonl` (hasil eksekusi host). Jalankan CLI `health` pada panduan reliability untuk menghitung ulang usia serta memverifikasi arsip. Jadwal Windows 20.00 WIB dan retensi tujuh hari memakai alur backup yang sama. Semua status/log/runtime ini tetap diabaikan Git. Laptop mati, Docker tidak tersedia, penyimpanan gagal atau lock sisa proses terputus dapat menggagalkan backup; status task mulai bukan bukti backup sukses.
