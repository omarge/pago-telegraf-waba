#!/usr/bin/env python3
"""Configura Caddy para KashBitPay WABA con backup y validación."""
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

CADDYFILE = Path("/etc/caddy/Caddyfile")
BACKUP_DIR = Path("/etc/caddy/backups")

NEW_CONFIG = """pagos.kashbit.bond {
    handle /webhook* {
        reverse_proxy 10.77.0.2:8766
    }
    handle /pay* {
        reverse_proxy 10.77.0.2:8765
    }
    handle {
        reverse_proxy 10.77.0.2:8765
    }
}
"""

def main():
    if not CADDYFILE.exists():
        print(f"ERROR: {CADDYFILE} no existe")
        sys.exit(1)

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = BACKUP_DIR / f"Caddyfile.{ts}.bak"
    shutil.copy2(CADDYFILE, backup)
    print(f"Backup: {backup}")

    tmp = Path("/tmp/Caddyfile.new")
    tmp.write_text(NEW_CONFIG)
    print("Validando...")
    r = subprocess.run(["caddy", "validate", "--config", str(tmp)], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERROR validación:\n{r.stderr}")
        sys.exit(1)
    print("Validación OK")

    shutil.copy2(tmp, CADDYFILE)
    print(f"Escrito: {CADDYFILE}")

    print("Recargando Caddy...")
    r = subprocess.run(["systemctl", "reload", "caddy"], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERROR reload:\n{r.stderr}")
        print("Restaurando backup...")
        shutil.copy2(backup, CADDYFILE)
        subprocess.run(["systemctl", "reload", "caddy"])
        sys.exit(1)
    print("Caddy recargado OK")

    print("\nPrueba:")
    print('curl -s "https://pagos.kashbit.bond/webhook?hub.mode=subscribe&hub.verify_token=TU_TOKEN&hub.challenge=test123"')

if __name__ == "__main__":
    main()
