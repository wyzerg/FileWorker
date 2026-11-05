"""Loopback-only protocol fixture. No system SSH configuration is used."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import asyncssh


async def main():
    root = Path(sys.argv[1])
    port = int(sys.argv[2])
    key_name = sys.argv[3]
    host_path = root / f"{key_name}.pem"
    if not host_path.exists():
        host_path.write_bytes(asyncssh.generate_private_key("ssh-ed25519").export_private_key())
        host_path.chmod(0o600)
    client_path = root / "client.pem"
    if not client_path.exists():
        client_path.write_bytes(
            asyncssh.generate_private_key("ssh-rsa", key_size=2048).export_private_key(
                "pkcs1-pem", passphrase="test-key-passphrase"
            )
        )
        client_path.chmod(0o600)
    public_key = asyncssh.read_private_key(
        client_path, passphrase="test-key-passphrase"
    ).convert_to_public()
    openssh_path = root / "client-ed25519"
    if not openssh_path.exists():
        subprocess.run([
            shutil.which("ssh-keygen") or "ssh-keygen", "-q", "-t", "ed25519",
            "-N", "test-ed25519-passphrase", "-f", str(openssh_path),
        ], check=True)
    openssh_public = asyncssh.read_public_key(str(openssh_path) + ".pub")
    plain_path = root / "client-plain"
    if not plain_path.exists():
        plain_path.write_bytes(asyncssh.generate_private_key("ssh-ed25519").export_private_key())
        plain_path.chmod(0o600)
    plain_public = asyncssh.read_private_key(plain_path).convert_to_public()
    files = root / "files"
    files.mkdir(exist_ok=True)
    (files / "folder").mkdir(exist_ok=True)
    (files / "physical" / "leaf").mkdir(parents=True, exist_ok=True)
    alias = files / "alias"
    if not alias.is_symlink():
        alias.symlink_to("physical/leaf", target_is_directory=True)
    (files / "folder" / "child.txt").write_text("child", encoding="utf-8")
    (files / "hello.txt").write_text("hello", encoding="utf-8")
    (files / ".hidden").write_text("hidden", encoding="utf-8")
    (files / "中文.txt").write_text("text", encoding="utf-8")
    (files / "dir\\name").write_text("backslash", encoding="utf-8")
    link = files / "folder-link"
    if not link.is_symlink():
        link.symlink_to("folder", target_is_directory=True)
    denied = files / "denied"
    denied.mkdir(exist_ok=True)
    denied.chmod(0)

    class Filesystem(asyncssh.SFTPServer):
        async def mkdir(self, path, attrs):
            if (root / "pause-mutation").exists():
                (root / "mutation-entered").write_text("ready", encoding="utf-8")
                while (root / "pause-mutation").exists():
                    await asyncio.sleep(0.01)
            return super().mkdir(path, attrs)

        async def read(self, file_obj, offset, size):
            if (root / "slow-transfers").exists():
                await asyncio.sleep(0.04)
            return super().read(file_obj, offset, size)

        async def write(self, file_obj, offset, data):
            if (root / "slow-transfers").exists():
                await asyncio.sleep(0.04)
            race = root / "race-target"
            if race.exists():
                (files / race.read_text()).write_bytes(b"created by another writer")
                race.unlink()
            return super().write(file_obj, offset, data)

        def rename(self, oldpath, newpath):
            if (root / "fail-commit").exists() and oldpath.endswith(b".part"):
                raise asyncssh.SFTPPermissionDenied("Injected commit failure")
            return super().rename(oldpath, newpath)

        def realpath(self, path):
            # Preserve physical symlink/.. semantics before mapping back into the sandbox.
            physical_root = os.fsencode(files.resolve())
            physical = os.path.realpath(physical_root + b"/" + path.lstrip(b"/"))
            if physical == physical_root:
                return b"/"
            if physical.startswith(physical_root + b"/"):
                return physical[len(physical_root):]
            raise asyncssh.SFTPNoSuchFile("Outside test sandbox")

    class Server(asyncssh.SSHServer):
        def connection_made(self, connection):
            if len(sys.argv) > 4 and sys.argv[4] == "repeat-algorithms":
                # Deliberately malformed peer input for the libssh2 bounds regression.
                connection._sig_algs = [b"rsa-sha2-512"] * 64 + list(connection._sig_algs)
            with (root / "connections").open("a") as log:
                log.write("connected\n")

        def connection_lost(self, exc):
            with (root / "disconnect-events").open("a") as log:
                log.write("closed\n")

        def begin_auth(self, username):
            return True

        def password_auth_supported(self):
            return True

        def public_key_auth_supported(self):
            return True

        def validate_password(self, username, password):
            with (root / "auth-events").open("a") as log:
                log.write("password\n")
            return username == "tester" and password == "test-password-only"

        def validate_public_key(self, username, key):
            with (root / "auth-events").open("a") as log:
                log.write("key\n")
            return username == "tester" and key in (public_key, openssh_public, plain_public)

    server = await asyncssh.create_server(
        Server, "127.0.0.1", port,
        reuse_address=True,
        server_host_keys=[str(host_path)],
        sftp_factory=lambda channel: Filesystem(channel, chroot=os.fsencode(files)),
    )
    print(json.dumps({"port": server.get_port(), "keyPath": str(client_path)}), flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
