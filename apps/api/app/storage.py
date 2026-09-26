"""Object storage for PDFs and rendered page images.

Two backends behind one three-function interface:

* ``s3`` — the real one. S3-compatible throughout, so MinIO in compose, and Supabase
  Storage or S3 in production, are the same code path. Page images go to the browser as
  short-lived presigned URLs rather than being proxied through FastAPI; a 40-page score
  is 40 image requests and none of them should occupy an application worker.
* ``local`` — a directory on disk, served by the API. Exists so the whole stack runs
  from a clone with nothing else installed: SQLite, inline jobs, local files. It is not
  a production option (no signing, no CDN, no shared filesystem across replicas) and
  refuses to start in prod.
"""

from __future__ import annotations

import functools
import shutil
from pathlib import Path
from typing import BinaryIO

from app.config import get_settings


def _is_local() -> bool:
    return get_settings().storage_backend == "local"


def _local_root() -> Path:
    root = Path(get_settings().local_storage_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _local_path(key: str) -> Path:
    root = _local_root()
    # Keys are server-generated, but resolving and re-checking costs nothing and means a
    # traversal bug in key construction cannot escape the storage directory.
    target = (root / key).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"Refusing to access {key!r} outside the storage root")
    return target


@functools.lru_cache
def _client():
    import boto3
    from botocore.client import Config

    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        region_name=s.s3_region,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket() -> None:
    if _is_local():
        _local_root()
        return
    s = get_settings()
    client = _client()
    try:
        client.head_bucket(Bucket=s.s3_bucket)
    except Exception:
        client.create_bucket(Bucket=s.s3_bucket)


def put_object(key: str, body: BinaryIO | bytes, content_type: str) -> str:
    if _is_local():
        path = _local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(body, bytes):
            path.write_bytes(body)
        else:
            with path.open("wb") as handle:
                shutil.copyfileobj(body, handle)
        path.with_suffix(path.suffix + ".type").write_text(content_type)
        return key

    s = get_settings()
    _client().put_object(Bucket=s.s3_bucket, Key=key, Body=body, ContentType=content_type)
    return key


def get_object(key: str) -> bytes:
    if _is_local():
        return _local_path(key).read_bytes()
    s = get_settings()
    return _client().get_object(Bucket=s.s3_bucket, Key=key)["Body"].read()


def content_type_of(key: str) -> str:
    if _is_local():
        marker = _local_path(key).with_suffix(_local_path(key).suffix + ".type")
        if marker.exists():
            return marker.read_text().strip()
    return "application/octet-stream"


def presigned_get(key: str, expires_in: int = 3600) -> str:
    s = get_settings()
    if _is_local():
        return f"/files/{key}"
    if s.s3_public_base_url:
        return f"{s.s3_public_base_url.rstrip('/')}/{key}"
    return _client().generate_presigned_url(
        "get_object", Params={"Bucket": s.s3_bucket, "Key": key}, ExpiresIn=expires_in
    )
