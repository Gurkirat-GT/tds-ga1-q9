import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const normalizedEmail = "24f3002454@ds.study.iitm.ac.in";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const server = new McpServer({
    name: "exam-challenge-server",
    version: "1.0.0",
  });

  server.registerTool(
    "solve_challenge",
    {
      description: "Solve the current exam challenge from the HTTP request header.",
      inputSchema: {},
    },
    async () => {
      const challenge = req.headers["x-exam-challenge"];
      if (typeof challenge !== "string" || !/^[0-9a-f]{32}$/.test(challenge)) {
        throw new Error("Missing or invalid X-Exam-Challenge header");
      }

      const answer = createHash("sha256")
        .update(`${challenge}:${normalizedEmail}`, "utf8")
        .digest("hex")
        .slice(0, 16);

      return { content: [{ type: "text", text: answer }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
