"""Allow running as `python -m smartest_tv` to start the MCP server."""

import os
import sys

try:
    from smartest_tv.server import mcp
except ImportError:
    print("MCP server requires fastmcp. Install with: pip install 'stv[mcp]'", file=sys.stderr)
    sys.exit(1)

transport = os.environ.get("STV_TRANSPORT", "stdio")
host = os.environ.get("STV_HOST", "127.0.0.1")
port = int(os.environ.get("STV_PORT", "8910"))

if transport == "stdio":
    mcp.run()
else:
    mcp.run(transport=transport, host=host, port=port)
