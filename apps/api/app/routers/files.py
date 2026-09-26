from fastapi import APIRouter, HTTPException, Response, status

from app import storage
from app.config import get_settings

router = APIRouter(tags=["files"])


@router.get("/files/{key:path}")
def get_file(key: str) -> Response:
    """Serve an object from the local development storage backend.

    Registered only when STORAGE_BACKEND=local. With S3 the browser fetches presigned
    URLs directly and never touches this route — deliberately, so page images do not
    consume application workers.

    Unauthenticated, matching the presigned-URL model it stands in for: possession of
    the key is the capability. Keys embed random UUIDs, so they are not guessable, and
    the backend is refused outright in prod.
    """
    if get_settings().storage_backend != "local":
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    try:
        body = storage.get_object(key)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found") from exc
    return Response(
        content=body,
        media_type=storage.content_type_of(key),
        headers={"Cache-Control": "private, max-age=3600"},
    )
