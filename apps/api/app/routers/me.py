from fastapi import APIRouter, Depends

from app.auth import current_user
from app.models import User
from app.schemas import UserRead

router = APIRouter(tags=["identity"])


@router.get("/me", response_model=UserRead)
def get_me(user: User = Depends(current_user)) -> UserRead:
    """Who the caller is, as this service understands them.

    The client needs its own user ID to tell "my profile" from "a part someone shared
    with me". It could decode that from the JWT, but then the dev-header path would
    have no answer and the frontend would need two ways to find out the same thing.
    """
    return UserRead.model_validate(user)
