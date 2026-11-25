#!/usr/bin/env python3
"""Replace only the Beta image on the existing analici-app deployment."""

import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener


ROOT = Path("/srv/analici/beta")
ORIGIN = "http://127.0.0.1:3107"
HTTP = build_opener(ProxyHandler({}))


def run(*args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Falha em {' '.join(args[:2])}.")
    return result.stdout.strip()


def compose(*args):
    return run("docker", "compose", "--project-directory", str(ROOT), "--project-name",
               "analici-beta", "-f", str(ROOT / "compose.yml"), *args, timeout=120)


def wait_for(path, expected, attempts=20):
    for _ in range(attempts):
        try:
            with HTTP.open(ORIGIN + path, timeout=3) as response:
                if response.status == expected:
                    return
        except HTTPError as error:
            with error:
                if error.code == expected:
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError(f"A rota {path} não retornou HTTP {expected}.")


def replace(path, data):
    original = path.stat()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            os.fchown(file.fileno(), original.st_uid, original.st_gid)
            os.fchmod(file.fileno(), stat.S_IMODE(original.st_mode))
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def release(args):
    env_path, revision_path = ROOT / ".env", ROOT / "revision"
    old_env, old_revision = env_path.read_bytes(), revision_path.read_bytes()
    previous_revision = old_revision.decode().strip()
    old_tag = "analici-beta:" + previous_revision[:7]
    new_tag = "analici-beta:" + args.revision[:7]
    if previous_revision != args.expect or old_tag == new_tag:
        raise RuntimeError("A revisão ativa diverge da revisão anterior esperada.")
    container = compose("ps", "-q", "beta")
    if not re.fullmatch(r"[0-9a-f]{12,64}", container):
        raise RuntimeError("O contêiner ativo do Beta não foi identificado.")
    old_image_id = run("docker", "image", "inspect", "--format", "{{.Id}}", old_tag)
    if run("docker", "inspect", "--format", "{{.Image}}", container) != old_image_id:
        raise RuntimeError("A imagem disponível para reversão difere da imagem ativa.")
    new_env, replaced = re.subn(rb"(?m)^BETA_IMAGE=" + re.escape(old_tag.encode()) + rb"$",
                               b"BETA_IMAGE=" + new_tag.encode(), old_env)
    if replaced != 1:
        raise RuntimeError("A configuração da imagem do Beta diverge do esperado.")
    compose("config", "--quiet")
    wait_for("/api/health", 200, attempts=2)
    wait_for("/armazenamento", 200, attempts=2)
    print(f"Verificado: somente BETA_IMAGE muda de {old_tag} para {new_tag}.", flush=True)
    if args.check:
        return

    run("docker", "image", "load", "--input", str(args.image), timeout=120)
    label = '{{index .Config.Labels "org.opencontainers.image.revision"}}'
    if run("docker", "image", "inspect", "--format", label, new_tag) != args.revision:
        raise RuntimeError("A revisão registrada na imagem não corresponde à revisão solicitada.")
    backup = Path(tempfile.mkdtemp(prefix=new_tag.split(":")[1] + "-", dir=ROOT / "releases"))
    (backup / "env.before").write_bytes(old_env)
    (backup / "revision.before").write_bytes(old_revision)
    print(f"Configuração anterior guardada em {backup}.", flush=True)
    try:
        replace(env_path, new_env)
        compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "beta")
        wait_for("/api/health", 200)
        wait_for("/ocorrencias", 200)
        wait_for("/armazenamento", 200)
        wait_for("/api/monitoring/dashboard?period=15m", 401)
        replace(revision_path, (args.revision + "\n").encode())
    except Exception:
        replace(env_path, old_env)
        replace(revision_path, old_revision)
        compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "beta")
        wait_for("/api/health", 200)
        print("A versão anterior do Beta foi restaurada.", flush=True)
        raise
    print("BETA_OCORRENCIAS_PUBLICADO", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--expect", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not all(re.fullmatch("[0-9a-f]{40}", value) for value in (args.expect, args.revision)):
        parser.error("Informe as duas revisões Git completas.")
    if os.geteuid() != 0 or socket.gethostname().split(".")[0] != "vmi3522521":
        parser.error("Execute com sudo somente na VPS analici-app.")
    with args.image.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != args.sha256:
            parser.error("A assinatura SHA-256 do pacote diverge do esperado.")
    if args.check:
        release(args)
    else:
        with open("/run/lock/analici-beta-deploy.lock", "a", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            release(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        raise SystemExit(str(exc))
