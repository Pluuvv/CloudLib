# Autoscaling dan uji banyak request

Repo ini menyertakan skrip dan YAML agar anggota tim dapat memakai konfigurasi
yang sama pada cluster masing-masing. HPA menyesuaikan Deployment `cloudlib-app`
antara 1–5 pod dengan target CPU rata-rata 70% dari CPU request. CPU request
100m berarti target sekitar 70m per pod. Scale-down memakai stabilisasi 300 detik.

## File yang dibagikan

| File | Fungsi |
| --- | --- |
| `scripts/test-autoscaling.py` | Request GET paralel, pantau HPA/pod, simpan CSV dan JSON |
| `scripts/tests/test_autoscaling.py` | Tes otomatis generator, tanpa beban ke aplikasi |
| `k8s/autoscaling/base/hpa.yaml` | Satu definisi HPA yang dipakai kedua konfigurasi |
| `k8s/kustomization.yaml` | Deployment standalone dan HPA di namespace `cloudlib` |
| `k8s/autoscaling/lab/kustomization.yaml` | Hanya HPA untuk namespace lab `capstone` |
| `k8s/argocd/application.yaml` | Template Argo CD lab yang menyerahkan replika ke HPA |

Python 3.10+ dan `kubectl` harus tersedia di PATH. Windows dapat memakai `py`;
Linux/macOS dapat memakai `python3`. Generator tidak membutuhkan paket pip.
Cluster harus menyediakan metrics-server, aplikasi yang Ready, dan CPU request
pada container aplikasi. K3s pada lab tim sudah menyediakan metrics-server.

## Lab tim dengan Argo CD/GitOps

Argo CD lab tetap membaca **repo terpisah `capstone-gitops`, path `overlays/dev`**.
YAML di app-repo adalah konfigurasi yang dibagikan; menaruhnya di GitHub app-repo
saja tidak otomatis mengubah manifest yang dipantau Argo CD.

Pada lab yang sudah mempunyai HPA aktif seperti lab tim saat ini, cukup lanjut
ke bagian uji beban. Untuk menambahkan autoscaling ke lab lain:

1. Dari root app-repo, render HPA untuk namespace lab dan salin ke checkout GitOps.
   Ganti lokasi checkout sesuai laptop masing-masing:

   ```powershell
   $GitOpsPath = "../gitops-repo"
   kubectl kustomize k8s/autoscaling/lab |
     Set-Content -Encoding utf8 "$GitOpsPath/base/hpa.yaml"
   ```

2. Tambahkan `- hpa.yaml` pada `resources` di `base/kustomization.yaml` repo
   GitOps. Hapus `spec.replicas` dari Deployment aplikasi dan hapus patch atau
   transformer overlay yang memaksa replika Deployment tersebut. HPA mengelola
   field ini; jangan mengubah replika PostgreSQL atau komponen lain.

3. Periksa `k8s/argocd/application.yaml`: sesuaikan `repoURL`, branch, path,
   destination dan nama Application dengan lab tujuan. Template ini memakai
   repo Gitea lokal, namespace aplikasi `capstone`, serta namespace Argo CD
   `argocd`. Pertahankan `ignoreDifferences` khusus `/spec/replicas` dan
   `RespectIgnoreDifferences=true`. Terapkan pengaturan Application sebelum
   mempromosikan perubahan GitOps:

   ```powershell
   kubectl --context k3d-capstone apply -f k8s/argocd/application.yaml
   kubectl kustomize "$GitOpsPath/overlays/dev" |
     kubectl --context k3d-capstone apply --dry-run=server -f -
   ```

4. Commit dan push perubahan **repo GitOps** ke branch yang dipantau Argo CD.
   Pertahankan image tag/digest aplikasi yang dipakai lab. Tunggu sinkronisasi,
   lalu periksa:

   ```powershell
   kubectl --context k3d-capstone -n capstone get hpa cloudlib-app
   kubectl --context k3d-capstone -n capstone top pods
   kubectl --context k3d-capstone -n capstone wait --for=condition=ScalingActive hpa/cloudlib-app --timeout=90s
   ```

Pipeline aplikasi tetap mempromosikan image ke GitOps seperti sebelumnya. Jangan
arahkan Application lab ke `overlays/dev` pada app-repo, karena path itu berada di
repo GitOps. Jika mengubah HPA di app-repo, promosikan versi YAML yang sama ke
repo GitOps agar deployment aktif mengikuti perubahan tersebut.

## Deployment standalone

Ikuti prasyarat image, Secret database dan konfigurasi Keycloak pada README.
`kubectl apply -k k8s` kini menyertakan HPA di namespace `cloudlib`, dengan nama
Deployment dan HPA `cloudlib-app`. Deployment tidak lagi memaksa dua replika.
Folder `k8s/argocd` tidak masuk hasil render standalone.

```powershell
kubectl --context k3d-campus-cloud apply -k k8s
kubectl --context k3d-campus-cloud -n cloudlib get hpa,pods
kubectl --context k3d-campus-cloud -n cloudlib top pods
```

Ganti context contoh dengan context cluster sendiri. Ingress standalone memakai
host `cloudlib.local`; sesuaikan IP/port ingress pada perintah uji di bawah.

## Menjalankan uji beban

Jalankan dari root app-repo. Untuk lab tim (`k3d-capstone`, namespace `capstone`,
ingress port 8088, Host `cloudlib.localhost`), default skrip sudah sesuai:

```powershell
py -B scripts/test-autoscaling.py --duration 300 --concurrency 32 --cooldown 420
```

Skrip mengirim GET berulang melalui 32 worker selama 5 menit, menghentikan request,
kemudian memantau scale-down selama 7 menit. Endpoint publik `/hello` tidak
memerlukan token dan tidak mengubah data. Jumlah worker bukan batas request per
detik. Uji memakai ingress supaya trafik dapat dibagikan ke pod Ready.

Untuk contoh standalone yang ingress-nya juga dipublikasikan pada port 8088:

```powershell
py -B scripts/test-autoscaling.py --context k3d-campus-cloud --namespace cloudlib --url http://127.0.0.1:8088/hello --host-header cloudlib.local --duration 300 --concurrency 32 --cooldown 420
```

Sesuaikan context, namespace, IP/port dan Host dengan cluster sendiri. Target
Deployment/HPA dapat diubah melalui `--deployment`; kedua objek harus memiliki
nama yang sama. `--cooldown 0` hanya memeriksa scale-up.

Pantau di terminal lain, misalnya untuk lab tim:

```powershell
kubectl --context k3d-capstone -n capstone get hpa cloudlib-app --watch
kubectl --context k3d-capstone -n capstone get pods --watch
```

Skrip memeriksa respons HTTP, metrik CPU, serta baseline desired/Ready pada
minReplicas sebelum mengirim beban. Tunggu scale-down alami jika uji sebelumnya
masih meninggalkan pod di atas minimum. Hindari `kubectl scale` saat HPA aktif.

## Hasil dan batas pengujian

Hasil berada di `scripts/.runtime/autoscaling/<timestamp-UTC>/` dan diabaikan Git,
terlepas dari direktori tempat skrip dipanggil. `--output-dir` memilih lokasi lain.

- `samples.csv`: CPU, desired/Ready replicas, status HPA dan jumlah request.
- `summary.json`: jumlah sukses/gagal, status HTTP, throughput dan verdict scaling.
- Exit 0: request berhasil tanpa error, HPA dan pod Ready bertambah, serta kembali
  ke minimum saat cooldown diaktifkan. Exit 1: salah satu syarat gagal. Argumen
  tidak valid menghasilkan exit 2.

Redirect, 401/403, 404, 5xx, respons terpotong dan error koneksi dihitung gagal.
CPU yang rendah mungkin tidak memicu scaling; tambah concurrency/durasi sesuai
kapasitas lab. Pod yang masih startup atau kekurangan resource belum dihitung
sebagai keberhasilan scale-up. Scale-down memerlukan beberapa menit sesuai
stabilisasi dan periode metrik. Ctrl+C menghentikan generator dan run tidak lulus.

HPA ini menambah pod berdasarkan CPU, bukan menghitung request secara langsung.
Kapasitas node/laptop dan PostgreSQL tetap membatasi layanan. Uji `/hello` menguji
mekanisme autoscaling; benchmark transaksi bisnis membutuhkan autentikasi dan
pengukuran tersendiri.

Tes generator tanpa mengirim beban ke CloudLib:

```powershell
py -B -m unittest discover -s scripts/tests -v
```

Referensi: [Kubernetes HPA](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/),
[Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/),
[Argo CD sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/#respect-ignore-differences-configs).
