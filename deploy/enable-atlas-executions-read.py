#!/usr/bin/env python3
"""Provision the dedicated Atlas execution reader and its WireGuard listener."""

import argparse
import fcntl
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile


ROLE = "analici_atlas_exec_read"
SOCKET = "analici-atlas-executions.socket"
SERVICE = "analici-atlas-executions.service"
LISTENER = "10.200.50.2:15432"
PROXY = "/usr/lib/systemd/systemd-socket-proxyd"
RULE = ("in", "on", "wg-analici", "from", "10.200.50.1", "to", "10.200.50.2", "port", "15432", "proto", "tcp")
HBA_RULE = f"host atlas {ROLE} 172.29.0.1/32 scram-sha-256\n".encode()
UNIT_DIR = Path("/etc/systemd/system")

SOCKET_CONTENT = """[Unit]
Description=Analici read-only access to Atlas over WireGuard
Requires=wg-quick@wg-analici.service
After=wg-quick@wg-analici.service

[Socket]
ListenStream=10.200.50.2:15432
BindToDevice=wg-analici

[Install]
WantedBy=sockets.target
"""
SERVICE_CONTENT = """[Unit]
Description=Forward the private Analici Atlas connection to PostgreSQL

[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:5432
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
"""


def run(*args, data=None, timeout=30):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout,
                            env={**os.environ, "LC_ALL": "C"})
    if result.returncode:
        raise RuntimeError(f"Falha em {' '.join(args[:2])}.")
    return result.stdout.strip()


def sql(query):
    return run("docker", "exec", "-u", "postgres", "-i", "atlas-postgres",
               "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "atlas",
               data=query, timeout=20)


def inspect(template):
    return run("docker", "inspect", "--format", template, "atlas-postgres")


def load_plan():
    if socket.gethostname().split(".")[0] != "atlas-core" or not os.access(PROXY, os.X_OK):
        raise RuntimeError("Identidade do Atlas core ou proxy do sistema não confirmados.")
    if run("systemctl", "is-active", "wg-quick@wg-analici.service") != "active":
        raise RuntimeError("O túnel WireGuard não está ativo.")
    if "dev wg-analici" not in run("ip", "-4", "route", "get", "10.200.50.1"):
        raise RuntimeError("O endereço do Analici não passa pelo túnel.")
    if run("ss", "-H", "-lnt", "sport", "=", ":15432"):
        raise RuntimeError("A porta reservada ao leitor já está em uso.")
    if sql(f"SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{ROLE}');") != "f":
        raise RuntimeError("O papel de leitura já existe. Use a configuração já provisionada.")
    if inspect('{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}') != "172.29.0.1":
        raise RuntimeError("O endereço da rede PostgreSQL difere do esperado.")
    hba = Path(inspect('{{range .Mounts}}{{if eq .Destination "/etc/atlas/postgres/pg_hba.conf"}}{{.Source}}{{end}}{{end}}'))
    if not hba.is_absolute() or Path("/srv/atlas") not in hba.resolve().parents or not hba.is_file():
        raise RuntimeError("O arquivo pg_hba do contêiner não foi identificado.")
    original = hba.read_bytes()
    deny_lines = list(re.finditer(rb"(?m)^host[ \t]+all[ \t]+all[ \t]+0\.0\.0\.0/0[ \t]+reject[ \t]*$", original))
    if len(deny_lines) != 1 or ROLE.encode() in original:
        raise RuntimeError("A regra final de acesso IPv4 difere do modelo verificado.")
    if any((UNIT_DIR / name).exists() for name in (SOCKET, SERVICE)):
        raise RuntimeError("Já existem unidades de encaminhamento para Execuções.")
    firewall = run("ufw", "status")
    return hba, original, deny_lines[0].start(), firewall.startswith("Status: active")


def update_hba(path, data):
    # Keep the inode because Docker bind-mounts this individual file.
    with path.open("r+b") as file:
        file.write(data)
        file.truncate()
        file.flush()
        os.fsync(file.fileno())


def apply(args):
    hba, before, insertion, firewall = load_plan()
    verifier = args.verifier.read_text().strip()
    if not re.fullmatch(r"SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+", verifier):
        raise RuntimeError("O verificador SCRAM do papel de leitura é inválido.")
    grants = args.grants.read_text().replace(':"reader"', ROLE)
    if grants.count("BEGIN;") != 1 or grants.count("COMMIT;") != 1:
        raise RuntimeError("O arquivo de concessões está incompleto.")
    print("Prévia: uma conta de leitura, uma regra PostgreSQL e um listener exclusivo do WireGuard.", flush=True)
    if args.check:
        return

    backup = Path(tempfile.mkdtemp(prefix="analici-atlas-executions-", dir=hba.parent))
    (backup / "pg_hba.before").write_bytes(before)
    role_created = hba_changed = firewall_changed = False
    installed = []
    try:
        definition = (
            f"BEGIN;\nCREATE ROLE {ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT "
            f"NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD '{verifier}';\n"
            f"ALTER ROLE {ROLE} IN DATABASE atlas SET default_transaction_read_only = on;\n"
        )
        sql(grants.replace("BEGIN;", definition))
        role_created = True
        hba_changed = True
        update_hba(hba, before[:insertion] + HBA_RULE + before[insertion:])
        if sql("SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;") != "0":
            raise RuntimeError("O PostgreSQL rejeitou a configuração de acesso.")
        if sql("SELECT pg_reload_conf();") != "t":
            raise RuntimeError("O PostgreSQL não recarregou a configuração de acesso.")

        for name, definition in ((SOCKET, SOCKET_CONTENT), (SERVICE, SERVICE_CONTENT)):
            target = UNIT_DIR / name
            with target.open("x") as file:
                installed.append(target)
                file.write(definition)
            target.chmod(0o644)
        run("systemd-analyze", "verify", str(UNIT_DIR / SOCKET), str(UNIT_DIR / SERVICE))
        if firewall:
            result = run("ufw", "allow", *RULE, "comment", "Analici Atlas Execucoes")
            firewall_changed = "Skipping" not in result
        run("systemctl", "daemon-reload")
        run("systemctl", "enable", "--now", SOCKET)
        listeners = run("ss", "-H", "-lnt", "sport", "=", ":15432").splitlines()
        if len(listeners) != 1 or listeners[0].split()[3].replace("%wg-analici", "") != LISTENER:
            raise RuntimeError("O serviço não escutou somente no endereço privado esperado.")
    except Exception:
        undo = []
        if installed:
            undo.append(lambda: run("systemctl", "disable", "--now", SOCKET))
            for target in installed:
                undo.append(target.unlink)
            undo.append(lambda: run("systemctl", "daemon-reload"))
        if firewall_changed:
            undo.append(lambda: run("ufw", "--force", "delete", "allow", *RULE))
        if hba_changed:
            undo.append(lambda: update_hba(hba, before))
            undo.append(lambda: sql("SELECT pg_reload_conf();"))
        if role_created:
            undo.append(lambda: sql(f"DROP OWNED BY {ROLE}; DROP ROLE {ROLE};"))
        for action in undo:
            try:
                action()
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                print(f"A reversão exige conferência. Cópia anterior em {backup}.", flush=True)
        raise
    print(f"Configuração PostgreSQL anterior guardada em {backup}.", flush=True)
    print("ATLAS_LEITURA_EXECUCOES_PRONTA", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verifier", required=True, type=Path)
    parser.add_argument("--grants", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise RuntimeError("Execute com sudo no Atlas core.")
        if arguments.check:
            apply(arguments)
        else:
            with open("/run/lock/analici-atlas-executions.lock", "a", encoding="utf-8") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                apply(arguments)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error))
