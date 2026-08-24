#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createElasticsearchMcpServer } from "./src/server.js";
import { loadConfigFromEnv } from "./src/config/schema.js";
import { installProcessSafetyNet } from "./src/processSafetyNet.js";

async function main() {
  // Installed before anything can throw asynchronously.
  installProcessSafetyNet();

  const config = loadConfigFromEnv();
  const transport = new StdioServerTransport();
  const server = await createElasticsearchMcpServer(config);

  await server.connect(transport);

  // SIGTERM as well as SIGINT: `docker stop` sends SIGTERM, and the image is a
  // supported way to run this server. Handling only SIGINT meant the container
  // was killed by Node's default handler without ever closing the session.
  //
  // The guard matters because both can arrive: a terminal sends SIGINT and an
  // orchestrator follows with SIGTERM, and closing twice throws.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Received ${signal}, closing the MCP session.`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(
    "Server error:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
