# 🔒 Audit Logging System

## Genel Bakış

Helix Agent, tüm kritik işlemleri kalıcı dosyalara kaydeden kapsamlı bir audit logging sistemi içerir. Bu sistem özellikle **UNRESTRICTED MODE** gibi güçlü yetenekler kullanıldığında güvenlik ve compliance için kritik öneme sahiptir.

## 📋 Özellikler

### ✅ Yapılanlar:

1. **Kalıcı Log Dosyaları**
   - `agent.log` - Tüm genel loglar (7 gün tutulur)
   - `audit.log` - Kritik audit eventleri (30 gün tutulur)
   - Otomatik rotation (10MB veya günlük)
   - Gzip compression (eski loglar)

2. **Structured Logging**
   - JSON formatında
   - Tam timestamp
   - Agent ID, hostname, PID
   - Tüm metadata

3. **Audit Event Tipleri**
   - `tool_call` - Her tool çağrısı
   - `system_operation` - File/process/service işlemleri
   - `security_violation` - Güvenlik ihlalleri
   - `auth` - Authentication eventleri
   - `error` - Hatalar

4. **Severity Levels**
   - `low` - Repo, git işlemleri
   - `medium` - Docker, network
   - `high` - System tools, runner.exec
   - `critical` - Security violations

5. **Auto-Rotation**
   - Dosya boyutu: 10MB
   - Zaman bazlı: Günlük
   - Max dosya: 30 audit / 7 genel
   - Otomatik compression

## 📂 Log Konumları

### Docker Container:
- Container içi: `/logs`
- Volume mount: `C:\Users\Admin\Desktop\HELIX-AGENT-LOGS`

### Log Dosyaları:
```
HELIX-AGENT-LOGS/
├── agent.log              # Genel loglar
├── audit.log              # Audit eventleri
├── agent.log.1.gz         # Rotated log (compressed)
├── agent.log.2.gz
├── audit.log.1.gz
└── audit.log.2.gz
```

## 🔍 Log Formatı

### Genel Log Entry:
```json
{
  "level": "info",
  "time": "2026-01-14T22:20:01.875Z",
  "agentId": "amd2700x",
  "pid": 1,
  "hostname": "AMD2700X",
  "msg": "Tool registered",
  "toolName": "system.file_ops"
}
```

### Audit Event Entry:
```json
{
  "level": "warn",
  "time": "2026-01-14T22:25:30.123Z",
  "agentId": "amd2700x",
  "pid": 1,
  "hostname": "AMD2700X",
  "audit": true,
  "timestamp": "2026-01-14T22:25:30.123Z",
  "eventType": "system_operation",
  "operation": "file_ops.delete",
  "args": {
    "source": "/tmp/test.txt",
    "force": true
  },
  "result": "success",
  "duration": 245,
  "severity": "high",
  "msg": "Audit: system_operation - success"
}
```

### Tool Call Entry:
```json
{
  "level": "info",
  "time": "2026-01-14T22:26:15.456Z",
  "agentId": "amd2700x",
  "audit": true,
  "eventType": "tool_call",
  "toolName": "runner.exec",
  "args": {
    "cmd": "docker",
    "args": ["ps", "-a"]
  },
  "result": "success",
  "duration": 1250,
  "severity": "high"
}
```

## 🛡️ Güvenlik Özellikleri

### 1. **Sensitive Data Redaction**
Şifreler, tokenlar, API keyler otomatik maskelenir:
```json
{
  "args": {
    "password": "[REDACTED]",
    "apiKey": "[REDACTED]",
    "username": "admin"
  }
}
```

### 2. **Content Truncation**
Büyük içerikler kesilir (200 karakter):
```json
{
  "args": {
    "content": "Long text here... [TRUNCATED]"
  }
}
```

### 3. **Failed Attempts Logging**
Başarısız işlemler daha yüksek severity ile loglanır:
```json
{
  "eventType": "tool_call",
  "result": "failure",
  "error": "Command not in allowlist: rm",
  "severity": "high"
}
```

### 4. **Security Violations**
İzin ihlalleri critical severity ile:
```json
{
  "eventType": "security_violation",
  "operation": "path_traversal_attempt",
  "result": "denied",
  "severity": "critical"
}
```

## 📊 Log Analizi

### PowerShell ile Log Okuma:

#### Son 50 audit event:
```powershell
Get-Content "C:\Users\Admin\Desktop\HELIX-AGENT-LOGS\audit.log" | 
  Select-Object -Last 50 | 
  ConvertFrom-Json | 
  Format-Table time, eventType, operation, result -AutoSize
```

#### System operations filtrele:
```powershell
Get-Content "C:\Users\Admin\Desktop\HELIX-AGENT-LOGS\audit.log" | 
  ConvertFrom-Json | 
  Where-Object { $_.eventType -eq "system_operation" } | 
  Format-Table time, operation, result, error
```

#### Failed attempts bul:
```powershell
Get-Content "C:\Users\Admin\Desktop\HELIX-AGENT-LOGS\audit.log" | 
  ConvertFrom-Json | 
  Where-Object { $_.result -eq "failure" } | 
  Format-List *
```

#### Specific tool çağrıları:
```powershell
Get-Content "C:\Users\Admin\Desktop\HELIX-AGENT-LOGS\audit.log" | 
  ConvertFrom-Json | 
  Where-Object { $_.toolName -eq "runner.exec" } | 
  Select-Object time, args, duration, result
```

### Linux ile Log Okuma:

#### Last 50 events:
```bash
tail -n 50 /logs/audit.log | jq '.'
```

#### System operations:
```bash
cat /logs/audit.log | jq 'select(.eventType == "system_operation")'
```

#### Failed attempts:
```bash
cat /logs/audit.log | jq 'select(.result == "failure")'
```

#### Stats by tool:
```bash
cat /logs/audit.log | jq -r '.toolName' | sort | uniq -c | sort -rn
```

## ⚙️ Yapılandırma

### Environment Variables:

```yaml
# docker-compose.yml
environment:
  AUDIT_LOG_ENABLED: "true"        # Enable/disable audit logging
  AUDIT_LOG_DIR: "/logs"           # Log directory (container path)
  LOG_LEVEL: "debug"               # Log level (debug, info, warn, error)
```

### Custom Log Directory:

```yaml
volumes:
  - /custom/path/logs:/logs        # Linux
  - D:\MyLogs:/logs               # Windows
```

## 📈 Monitoring & Alerting

### Log Dosya Boyutları İzle:
```powershell
Get-ChildItem "C:\Users\Admin\Desktop\HELIX-AGENT-LOGS" | 
  Select-Object Name, @{N='Size(MB)';E={[math]::Round($_.Length/1MB,2)}} |
  Format-Table -AutoSize
```

### Günlük İstatistikler:
```powershell
$today = (Get-Date).Date
Get-Content "C:\Users\Admin\Desktop\HELIX-AGENT-LOGS\audit.log" |
  ConvertFrom-Json |
  Where-Object { [datetime]$_.time -ge $today } |
  Group-Object eventType |
  Select-Object Name, Count |
  Format-Table -AutoSize
```

## 🚨 Önemli Notlar

1. **Disk Alanı**
   - Audit logs 30 gün, genel logs 7 gün
   - Rotated loglar gzip compressed
   - Ortalama: ~1-5 MB/gün (kullanıma bağlı)
   - High-activity: 10-50 MB/gün

2. **Performance**
   - Async logging (non-blocking)
   - Minimal overhead (<5ms per log)
   - Rotating streams for efficiency

3. **Retention**
   - Production: 30-90 gün önerilir
   - Compliance: Gereksinime göre ayarlayın
   - Backup: Logları düzenli yedekleyin

4. **Privacy**
   - Sensitive data otomatik maskelenir
   - GDPR compliant (PII koruması)
   - Custom redaction patterns eklenebilir

## 🔧 Troubleshooting

### Loglar yazılmıyor:
1. Volume mount kontrol et: `docker inspect helix-home-agent`
2. Permissions kontrol et: Container /logs yazabilmeli
3. Disk alanı kontrol et: `df -h` (Linux) / `Get-PSDrive` (Windows)

### Log rotation çalışmıyor:
1. rotating-file-stream versiyonu kontrol et
2. Log dosyası kilitli mi kontrol et
3. Container restart gerekebilir

### Performance sorunları:
1. LOG_LEVEL='info' kullan (debug yerine)
2. Rotation size küçült (5MB)
3. Retention süresini azalt (15 gün)

## 📚 Daha Fazla

- [Pino Logger Documentation](https://getpino.io/)
- [Rotating File Stream](https://github.com/iccicci/rotating-file-stream)
- [Agent README](../README.md)
