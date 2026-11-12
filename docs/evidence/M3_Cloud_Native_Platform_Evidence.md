# Milestone 3 Evidence Report: Cloud-Native Platform
**Project**: CloudLib (Campus Library Information System with Multi-Tenancy Architecture)
**Track**: Campus Services
**Kelompok**: 6 (Kelas B, UPN Veteran Jakarta)
**Timestamp**: 2026-11-12T20:46:00+07:00
**Status**: Docker image built and 2/2 application pods rolled out successfully on k3d; ingress reachability not verified

---

## 1. Ringkasan Eksekutif Milestone 3
Milestone 3 membuktikan container build berhasil dan Deployment CloudLib berjalan dengan 2/2 pod Ready pada cluster k3d `campus-cloud`. Manifes memisahkan konfigurasi non-sensitif dan Secret runtime, serta mendeklarasikan probes, resource requests/limits, Service, dan Ingress. Akses melalui Ingress belum diuji.

---

## 2. Tabel Bukti Formal (Evidence Register) Sesuai Standar Pedoman Capstone

| Evidence ID | Scope | Owner | Source / Version | Method | Observation | Interpretation | Limitation | Decision Supported |
|---|---|---|---|---|---|---|---|---|
| **EVD-M3-01** | Kontainerisasi Multi-Stage | Kelompok 6 | `Dockerfile` & `src/main/docker/Dockerfile.jvm` | `docker build -t cloudlib:1.0.0 .` | Build image berhasil dengan builder Maven/Temurin 21, runtime UBI-9 OpenJDK 21, Quarkus fast-jar layers, dan UID non-root 185. | Image JVM dapat dibangun secara repeatable dari source tanpa memakai Maven Wrapper di container. | Native GraalVM belum dicoba. | Memvalidasi containerization pada Mandatory Baseline. |
| **EVD-M3-02** | Isolasi Namespace & Deklarasi Platform | Kelompok 6 | `k8s/00-namespace.yaml`, `k8s/kustomization.yaml` | `kubectl kustomize k8s` dan `kubectl apply -k .\k8s` | Kustomize merender 8 objek; namespace, ConfigMap, PVC, Deployments, Services, dan Ingress diterima cluster. | Seluruh komponen sistem terisolasi rapi di dalam namespace `cloudlib`. | Ingress host routing belum diuji dari klien. | Mendukung deklarasi infrastruktur berbasis kode (GitOps-ready). |
| **EVD-M3-03** | Pemisahan Config & Secret | Kelompok 6 | `k8s/01-configmap.yaml`, `k8s/03-postgres.yaml`, `k8s/04-cloudlib-deployment.yaml` | Secret runtime dibuat melalui `kubectl create secret`; deployment memuatnya melalui `secretKeyRef` | URL/username database berada di ConfigMap; PostgreSQL dan app memakai Secret `cloudlib-secret`. Nilai Secret tidak disimpan di Git. | Memisahkan konfigurasi non-sensitif dari kredensial dan menghindari nilai secret dalam repo. | Kubernetes Secret bukan enkripsi saat-at-rest tanpa konfigurasi cluster tambahan. | Memvalidasi pemisahan Config & Secret untuk M3. |
| **EVD-M3-04** | Alokasi Resource & Scaling | Kelompok 6 | `k8s/04-cloudlib-deployment.yaml` | Inspeksi deklarasi resources dan replicas | Requests: CPU 100m, Mem 256Mi; Limits: CPU 500m, Mem 512Mi. Replicas: 2 dengan RollingUpdate strategy. | Menetapkan resource baseline dan target dua replika untuk deployment. | Belum diuji pada cluster; dua replika tidak menjamin HA tanpa kapasitas dan dependensi yang sesuai. | Memvalidasi konfigurasi ADR-004 dan baseline Kubernetes Orchestration. |
| **EVD-M3-05** | Health Probes Cloud-Native | Kelompok 6 | `k8s/04-cloudlib-deployment.yaml`, `MyLivenessCheck.java` | Rollout status dan readiness dua pod pada cluster | Startup, liveness, dan readiness probes terkonfigurasi; rollout selesai dengan 2/2 replika Ready. | Kubernetes menahan trafik hingga pod siap; probe startup melewati fase inisialisasi aplikasi. | Restart akibat kegagalan probe belum diuji. | Memvalidasi konfigurasi QS05 & ADR-007. |
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

Status sintaks: **Valid (Exit code 0, 8 Kubernetes objects rendered)**. Deployment rollout: **2/2 replicas Ready** on k3d `campus-cloud`; Ingress route not yet tested.
