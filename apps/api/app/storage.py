"""Object storage for PDFs and rendered page images.

S3-compatible throughout: MinIO in docker compose, Supabase Storage or S3 in prod, one
code path. Page images are served to the browser via short-lived presigned URLs rather
than proxied through FastAPI — a 40-page score is ~40 image requests and none of them
should occupy an application worker.
"""

from __future__ import annotations

import functools
from typing import BinaryIO

import boto3
from botocore.client import Config

from app.config import get_settings


@functools.lru_cache
def _client():
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
    s = get_settings()
    client = _client()
    try:
        client.head_bucket(Bucket=s.s3_bucket)
    except Exception:
        client.create_bucket(Bucket=s.s3_bucket)


def put_object(key: str, body: BinaryIO | bytes, content_type: str) -> str:
    s = get_settings()
    _client().put_object(Bucket=s.s3_bucket, Key=key, Body=body, ContentType=content_type)
    return key


def get_object(key: str) -> bytes:
    s = get_settings()
    return _client().get_object(Bucket=s.s3_bucket, Key=key)["Body"].read()


def presigned_get(key: str, expires_in: int = 3600) -> str:
    s = get_settings()
    if s.s3_public_base_url:
        return f"{s.s3_public_base_url.rstrip('/')}/{key}"
    return _client().generate_presigned_url(
        "get_object", Params={"Bucket": s.s3_bucket, "Key": key}, ExpiresIn=expires_in
    )
