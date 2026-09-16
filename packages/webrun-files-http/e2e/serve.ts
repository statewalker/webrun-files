/** Run the test server by hand: `pnpm e2e:serve`, then open the printed URL. */
import { startTestServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const server = await startTestServer({ port, minPartSize: 64 * 1024 });
const encoder = new TextEncoder();
await server.fs.write("/welcome.txt", [encoder.encode("Hello over HTTP!\n")]);
await server.fs.write("/docs/readme.md", [encoder.encode("# Files over HTTP\n")]);
await server.fs.mkdir("/empty");
console.log(`Files API test page: ${server.url}/  (API at ${server.url}/api/files)`);
console.log(`Try ${server.url}/?partSize=65536&pageSize=2 to force several parts and pages.`);
