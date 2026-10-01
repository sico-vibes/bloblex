import readline from "node:readline";

const mode = process.argv[2] ?? "success";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequest = null;
let permissionRequestId = null;
let initializeRequest = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function finishPrompt(stopReason) {
  if (!promptRequest) return;
  send({
    jsonrpc: "2.0",
    id: promptRequest.id,
    result: { stopReason },
  });
  promptRequest = null;
}

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "initialize") {
    initializeRequest = message;
    send({
      jsonrpc: "2.0",
      id: message.id,
      method: "client/unimplemented",
      params: {},
    });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-session" } });
    return;
  }
  if (message.method === "session/load" || message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    promptRequest = message;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "native-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "fixture response" },
        },
      },
    });
    if (mode === "permission") {
      permissionRequestId = "permission-1";
      send({
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: "session/request_permission",
        params: {
          sessionId: "native-session",
          toolCall: { title: "Run fixture command", rawInput: "echo safe" },
          options: [
            { optionId: "allow_once", kind: "allow_once" },
            { optionId: "reject_once", kind: "reject_once" },
          ],
        },
      });
    } else if (mode !== "cancel") {
      finishPrompt("end_turn");
    }
    return;
  }
  if (message.method === "session/cancel" && mode === "cancel") {
    finishPrompt("cancelled");
    return;
  }
  if (
    permissionRequestId !== null &&
    message.id === permissionRequestId &&
    message.result?.outcome?.outcome === "cancelled"
  ) {
    finishPrompt("cancelled");
  } else if (
    permissionRequestId !== null &&
    message.id === permissionRequestId &&
    message.result?.outcome?.optionId
  ) {
    finishPrompt("end_turn");
  }
  if (
    message.id === initializeRequest?.id &&
    message.error?.code === -32601
  ) {
    send({
      jsonrpc: "2.0",
      id: initializeRequest?.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
  }
});
