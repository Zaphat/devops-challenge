## Problem 3 — Troubleshooting a VM at 99% storage

If I’m on call for this, I would treat it as a storage incident first and a NGINX incident second. The VM is only running a load balancer, so my first suspicion would be log growth or a file handle issue rather than application data.

### What I would check first

I’d confirm whether the problem is real disk usage or inode exhaustion, then I’d look for the biggest consumers on the filesystem.

```bash
df -h
df -i
sudo du -xhd1 / | sort -h
sudo du -xhd1 /var | sort -h
sudo du -xhd1 /var/log | sort -h
sudo lsof +L1
sudo journalctl --disk-usage
sudo systemctl status nginx
```

I’m specifically looking for one of two things:
- logs growing too fast
- deleted files still being held open by a process

---

## Issue 1: Logs are filling the disk

This is the most likely case in a NGINX-only VM. If access logs, error logs, or systemd journal logs are not rotating correctly, disk usage can climb very quickly.

### What I would expect to find

- `access.log` or `error.log` is much larger than expected
- `journald` has a lot of retained logs
- logrotate is missing, broken, or not reloading NGINX after rotation
- traffic spikes, bots, or noisy 4xx/5xx responses are generating too many log lines

### How I would prove it

```bash
sudo ls -lh /var/log/nginx
sudo tail -n 100 /var/log/nginx/error.log
sudo grep -R "access_log\|error_log" /etc/nginx/nginx.conf /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null
sudo cat /etc/logrotate.d/nginx
sudo logrotate -d /etc/logrotate.d/nginx
sudo journalctl --disk-usage
```

### Impact

If the disk keeps filling, NGINX may stop writing logs, reloads may fail, and the VM can start failing in unrelated ways too. That includes package installs, temp file creation, SSH stability, and monitoring agents. In the worst case, the load balancer becomes unstable or stops serving traffic.

### Recovery

My first move would be to free space safely, not just delete files blindly.

If I still have enough disk headroom, I would archive the logs first so I can diagnose the incident later. A simple approach is to compress the relevant logs and upload them to S3 before truncating anything locally.

```bash
tar -czf /tmp/nginx-logs-$(date +%F-%H%M%S).tar.gz /var/log/nginx
aws s3 cp /tmp/nginx-logs-*.tar.gz s3://your-bucket/incidents/
sudo truncate -s 0 /var/log/nginx/access.log
sudo truncate -s 0 /var/log/nginx/error.log
sudo journalctl --vacuum-time=3d
sudo logrotate -f /etc/logrotate.d/nginx
sudo nginx -t
sudo systemctl reload nginx
```

Then I’d fix the root cause:
- make sure `/etc/logrotate.d/nginx` rotates regularly and reloads NGINX after rotation
- cap journald usage in `/etc/systemd/journald.conf`
- reduce noisy logs where possible, especially for health checks
- centralize logs so the VM keeps only short retention locally

### Prevention

- alert at 75%, 85%, and 95% disk usage
- monitor log growth, not just total disk usage
- keep local logs short and ship the rest to a central logging system
- rate limit or block abusive traffic that floods the logs

---

## Issue 2: Deleted files are still open

This is the other common production issue. Someone removes a log file, but the process still has it open, so the disk space is not actually freed.

### What I would expect to find

- `df -h` still shows high usage
- `du` looks smaller than the actual disk usage
- `lsof +L1` shows large deleted files still attached to NGINX or another logging process

### How I would prove it

```bash
df -h
sudo du -sh /var/log
sudo lsof +L1
```

If I see `(deleted)` in the output with a large file size, that’s the answer.

### Impact

This is tricky because it looks like cleanup should have worked, but the space still does not come back. That means the VM can stay near 100% even after someone tries to delete logs, and the incident takes longer to understand and fix.

### Recovery

I would close the open file handles by reloading or restarting the service.

```bash
sudo systemctl reload nginx
sudo systemctl restart nginx
df -h
sudo lsof +L1
```

If the deleted files disappear from `lsof +L1`, the space should come back.

### Prevention

- never delete active logs manually
- use logrotate with a proper post-rotate reload
- make “truncate/rotate then reload” the standard runbook
- monitor for deleted-open files so this does not surprise you again

---

## Quick extra check: inode exhaustion

I would also check inodes, because sometimes “99% storage” is really “99% inodes”. That can happen if the VM has a huge number of tiny files.

```bash
df -i
```

If inode usage is full, the fix is usually to clean up a lot of small files in logs, cache, or temp directories.

---

## What I would do after recovery

- keep 5-10% of the disk as emergency headroom
- make disk and inode alerts part of normal monitoring
- track log growth separately from total storage
- document the exact recovery commands in the on-call runbook
- only increase disk size after the real cause is fixed

---

## Short version

For this VM, I would expect two likely causes:
1. logs are growing too fast or not rotating correctly
2. deleted files are still being held open by a process

My approach would be: check `df`, `du`, `lsof`, and `journalctl`, free space safely with truncate/vacuum/rotate, reload NGINX, and then fix retention and monitoring so it doesn’t happen again.
