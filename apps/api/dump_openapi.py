"""Write the OpenAPI schema to a file (used by the TypeScript codegen step)."""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app.main import app  # noqa: E402

target = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
target.write_text(json.dumps(app.openapi(), indent=2) + "\n")
print(f"wrote {target}")
