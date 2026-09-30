import { createHash } from "node:crypto";
import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { advanceTelemetry, getTelemetrySnapshot } from "./lib/telemetry";

type ClientSocket = import("node:stream").Duplex;

const sockets = new Set<ClientSocket>();
const websocketMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function makeWebSocketFrame(payload: string | Buffer, opcode = 0x1): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  let header: Buffer;

  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  return Buffer.concat([header, body]);
}

function sendJson(socket: ClientSocket, payload: unknown): void {
  if (!socket.destroyed && socket.writable) {
    socket.write(makeWebSocketFrame(JSON.stringify(payload)));
  }
}

function removeSocket(socket: ClientSocket): void {
  sockets.delete(socket);
}

const server = createServer(app);

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const websocketKey = request.headers["sec-websocket-key"];

  if (
    pathname !== "/api/ws" ||
    typeof websocketKey !== "string" ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(websocketKey + websocketMagic)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  sockets.add(socket);
  socket.on("close", () => removeSocket(socket));
  socket.on("error", (err) => {
    logger.warn({ err }, "Telemetry WebSocket connection error");
    removeSocket(socket);
  });
  socket.on("data", (data) => {
    // Browsers send masked control frames. Only a close response is needed for
    // this server-push stream; client application messages are not supported.
    if (data.length > 0 && (data[0] & 0x0f) === 0x8) {
      socket.end(makeWebSocketFrame(Buffer.alloc(0), 0x8));
      removeSocket(socket);
    }
  });

  if (head.length > 0 && (head[0] & 0x0f) === 0x8) {
    socket.end(makeWebSocketFrame(Buffer.alloc(0), 0x8));
    removeSocket(socket);
    return;
  }

  sendJson(socket, { type: "snapshot", ...getTelemetrySnapshot() });
});

setInterval(() => {
  const sources = advanceTelemetry();
  const message = {
    type: "update",
    generatedAt: new Date(),
    updates: sources,
  };

  for (const socket of sockets) {
    sendJson(socket, message);
  }
}, 1000).unref();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
