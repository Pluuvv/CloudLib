# Local monitoring

The Compose stack runs Prometheus on `127.0.0.1:9090` and Grafana on
`127.0.0.1:3000`. Prometheus scrapes `http://host.docker.internal:8080/q/metrics`,
so the local CloudLib app must be reachable on port 8080 for this target to be
healthy.

Set a private Grafana admin password before starting the stack (PowerShell):

```powershell
$secret = Read-Host "Grafana admin password" -AsSecureString
$env:GRAFANA_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $secret).Password
docker compose -f .\monitoring\docker-compose-monitoring.yml up -d
```

Keep the environment variable set for later Compose commands, then clear it
when finished:

```powershell
Remove-Item Env:\GRAFANA_ADMIN_PASSWORD
```

The dashboard reports measured request, error, and **average** latency metrics.
It does not estimate p50/p90/p95 from averages; use the capacity benchmark
report for measured latency percentiles. A panel with no data means the metric
is unavailable or has not yet been scraped, not that the service has zero
errors or perfect availability.
