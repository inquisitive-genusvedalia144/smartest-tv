FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml README.md LICENSE ./
COPY src/ src/

RUN pip install --no-cache-dir .

# MCP server via stdio (default) or SSE
ENV STV_TRANSPORT=stdio
EXPOSE 8910

ENTRYPOINT ["python", "-m", "smartest_tv"]
