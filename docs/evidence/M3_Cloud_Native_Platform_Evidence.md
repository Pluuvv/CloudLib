# Milestone 3 Evidence Report: Cloud-Native Platform
**Project**: CloudLib (Campus Library Information System with Multi-Tenancy Architecture)
**Track**: Campus Services
**Kelompok**: 6 (Kelas B, UPN Veteran Jakarta)
**Timestamp**: 2026-11-12T20:46:00+07:00
**Status**: Kubernetes manifests validated; Docker image build and live-cluster deployment not verified

---

## 1. Ringkasan Eksekutif Milestone 3
Milestone 3 menyediakan Dockerfile multi-stage dan manifes Kubernetes yang terstruktur, memisahkan runtime configuration dari credential/secret, serta mendeklarasikan probes dan resource requests/limits. Kustomize berhasil merender delapan objek; Docker image dan rollout live belum diverifikasi pada lingkungan ini.

---

## 2. Tabel Bukti Formal (Evidence Register) Sesuai Standar Pedoman Capstone

| Evidence ID | Scope | Owner | Source / Version | Method | Observation | Interpretation | Limitation | Decision Supported |
|---|---|---|---|---|---|---|---|---|
| **EVD-M3-01** | Kontainerisasi Multi-Stage | Kelompok 6 | `Dockerfile` & `src/main/docker/Dockerfile.jvm` | Inspeksi Dockerfile; `docker build` belum dapat dijalankan karena Docker daemon tidak tersedia | Dockerfile mendeklarasikan build Temurin-21, runtime UBI-9 OpenJDK 21, layer Quarkus terpisah, dan UID non-root 185. | Desain container mengikuti baseline reproducible build dan non-root runtime. | Belum menghasilkan atau menjalankan image pada validasi ini; native GraalVM juga belum dicoba. | Memvalidasi konfigurasi container; image runtime masih perlu diuji. |
| **EVD-M3-02** | Isolasi Namespace & Deklarasi Platform | Kelompok 6 | `k8s/00-namespace.yaml`, `k8s/kustomization.yaml` | Eksekusi `kubectl kustomize k8s` | Kustomize merender 8 objek Kubernetes dari namespace, ConfigMap, PVC, Deployment, Service, dan Ingress tanpa error. | Seluruh komponen sistem terisolasi rapi di dalam namespace `cloudlib`. | Validasi sintaks client-side; belum membuktikan objek diterima cluster atau pod siap. | Mendukung deklarasi infrastruktur berbasis kode (GitOps-ready). |
| **EVD-M3-03** | Pemisahan Config & Secret | Kelompok 6 | `k8s/01-configmap.yaml`, `k8s/03-postgres.yaml`, `k8s/04-cloudlib-deployment.yaml` | Inspeksi ConfigMap dan secretKeyRef; Secret runtime dibuat terpisah sebelum deployment | URL/username database berada di ConfigMap; Deployment hanya merujuk Secret `cloudlib-secret`. Manifest Secret berisi nilai kredensial tidak disimpan di Git. | Memisahkan konfigurasi non-sensitif dari kredensial dan menghindari nilai secret dalam repo. | Secret harus dibuat operator sebelum apply; Kubernetes Secret sendiri bukan enkripsi saat-at-rest tanpa konfigurasi cluster tambahan. | Memenuhi pemisahan Config & Secret untuk M3. |
| **EVD-M3-04** | Alokasi Resource & Scaling | Kelompok 6 | `k8s/04-cloudlib-deployment.yaml` | Inspeksi deklarasi resources dan replicas | Requests: CPU 100m, Mem 256Mi; Limits: CPU 500m, Mem 512Mi. Replicas: 2 dengan RollingUpdate strategy. | Menetapkan resource baseline dan target dua replika untuk deployment. | Belum diuji pada cluster; dua replika tidak menjamin HA tanpa kapasitas dan dependensi yang sesuai. | Memvalidasi konfigurasi ADR-004 dan baseline Kubernetes Orchestration. |
| **EVD-M3-05** | Health Probes Cloud-Native | Kelompok 6 | `k8s/04-cloudlib-deployment.yaml`, `MyLivenessCheck.java` | Inspeksi konfigurasi probe untuk `/q/health/live`, `/q/health/ready`, dan `/q/health/started` | Manifest mendeklarasikan liveness, readiness, dan startup probes. | Konfigurasi tersebut memungkinkan Kubernetes mengatur kesiapan trafik dan restart container saat dijalankan pada cluster. | Perilaku probe belum diverifikasi pada runtime Kubernetes. | Memvalidasi konfigurasi QS05 & ADR-007. |
| **EVD-M3-06** | Service Discovery & Ingress | Kelompok 6 | `k8s/05-cloudlib-service.yaml`, `k8s/06-ingress.yaml` | Inspeksi Service ClusterIP port 8080 dan Ingress Traefik host `cloudlib.local` | Service dan Ingress dideklarasikan dengan host `cloudlib.local`. | Platform menyediakan jalur ingress yang dapat diuji setelah manifest diterapkan ke cluster dengan Traefik. | DNS/hosts dan live routing belum diverifikasi. | Memvalidasi konfigurasi ADR-009 topologi satu host. |

---

## 3. Hasil Validasi Deklaratif Manifes (Kustomize Verification)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: cloudlib
    app.kubernetes.io/name: cloudlib
    app.kubernetes.io/version: 1.0.0
  name: cloudlib-app
  namespace: cloudlib
spec:
  replicas: 2
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
    type: RollingUpdate
  template:
    spec:
      containers:
      - name: cloudlib
        image: cloudlib:1.0.0
        ports:
        - containerPort: 8080
          name: http
        livenessProbe:
          httpGet:
            path: /q/health/live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /q/health/ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
        startupProbe:
          httpGet:
            path: /q/health/started
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 20
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

Status sintaks: **Valid (Exit code 0, 8 Kubernetes objects rendered)**. A live Kubernetes rollout has not yet been verified.
