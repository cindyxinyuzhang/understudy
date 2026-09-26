"""Shared Pydantic base: snake_case in Python, camelCase on the wire.

One shape everywhere — the JSON stored in `score_versions.doc`, the JSON on the wire,
and the TypeScript type generated from OpenAPI are byte-identical. Without this the
frontend would need a mapping layer, which is exactly the kind of hand-maintained
translation the generated-types approach exists to delete.
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        ser_json_timedelta="float",
    )
