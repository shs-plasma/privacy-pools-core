import http from "node:http";

/** The base URL of the test artifact server, available after setup(). */
export let testServerUrl: string = "";

async function startServer(host: string, port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pong");
      } else if (
        req.url?.startsWith("/artifacts") &&
        req.url === "/artifacts/withdraw.wasm"
      ) {
        const data = new Uint8Array([0, 1, 2, 3]);
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(data);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("ErrorNotFound\n");
      }
    });
    server.listen(port, host, () => resolve(server));
  });
}

let teardownHappened = false;
let server: http.Server;

export async function setup() {
  server = await startServer("127.0.0.1", 0);
  const addr = server.address();
  if (addr && typeof addr === "object") {
    testServerUrl = `http://127.0.0.1:${addr.port}`;
    process.env.TEST_ARTIFACT_SERVER_URL = testServerUrl;
  }
}

export async function teardown() {
  if (teardownHappened) {
    throw new Error("teardown called twice");
  }
  teardownHappened = true;
  server.close();
}
