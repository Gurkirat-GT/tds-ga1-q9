# Exam MCP server

This stateless MCP server exposes `solve_challenge` at `/api/mcp`. Each call
reads `X-Exam-Challenge` from that HTTP request and returns the first 16
lowercase hexadecimal characters of
`SHA-256("<challenge>:24f3002454@ds.study.iitm.ac.in")`.

## Deploy to Vercel

Import this repository into Vercel and set **Root Directory** to `mcp-server`.
The Vercel project will publish the MCP endpoint at
`https://<your-deployment-domain>/api/mcp`.

The endpoint uses the official MCP TypeScript SDK over Streamable HTTP and
does not require environment variables or persistent sessions.
