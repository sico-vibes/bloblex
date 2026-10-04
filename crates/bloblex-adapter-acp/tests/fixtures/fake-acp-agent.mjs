import fs from "node:fs";
import readline from "node:readline";

const mode = process.argv[2] ?? "success";
const INTERLEAVE_DELAY_MS = 5000;
const pidArgument = process.argv[3];
const pidLog = pidArgument?.includes("/") || pidArgument?.includes("\\") ? pidArgument : undefined;
const crashEnabled = (mode === "crash" || mode === "crash-reject") && (!pidLog || !fs.existsSync(pidLog) || !fs.readFileSync(pidLog, "utf8").includes("start:"));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Set();
const prompts = new Map();
const permissions = new Map();
let nextSession = 1;
let initializeRequest = null;

function record(value) {
  if (pidLog) fs.appendFileSync(pidLog, `${value}\n`);
}

record(`start:${process.pid}`);
process.on("exit", () => record(`exit:${process.pid}`));

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function finishPrompt(sessionId, stopReason) {
  const prompt = prompts.get(sessionId);
  if (!prompt) return;
  send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason } });
  prompts.delete(sessionId);
}

function configOptions() {
  return [
    { id: "model", currentValue: "model-default", options: [
      { value: "model-default", name: "Default" },
      { value: "model-a", name: "Model A" },
      { value: "model-b", name: "Model B" },
    ] },
    { id: "mode", currentValue: "build", options: [
      { value: "build", name: "Build" },
      { value: "bloblex", name: "Bloblex" },
    ] },
  ];
}

input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.method === "initialize") {
    initializeRequest = message;
    send({ jsonrpc: "2.0", id: message.id, method: "client/unimplemented", params: {} });
    return;
  }
  if (message.method === "session/new") {
    const sessionId = `native-session-${nextSession++}`;
    sessions.add(sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: configOptions() } });
    return;
  }
  if (message.method === "session/load") {
    record(`load:${message.params.sessionId}`);
    if (mode === "crash-reject" && !crashEnabled) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "session not found" } });
      return;
    }
    sessions.add(message.params.sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params.sessionId, configOptions: configOptions() } });
    return;
  }
  if (message.method === "session/close") {
    sessions.delete(message.params.sessionId);
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    if (crashEnabled && message.params.prompt?.[0]?.text === "crash") {
      setTimeout(() => process.exit(23), 100);
      return;
    }
    prompts.set(sessionId, message);
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `fixture response:${sessionId}` },
        },
      },
    });
    if (mode === "permission") {
      const permissionId = `permission:${sessionId}`;
      permissions.set(permissionId, sessionId);
      send({
        jsonrpc: "2.0",
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { title: "Run fixture command", rawInput: "echo safe" },
          options: [
            { optionId: "allow_once", kind: "allow_once" },
            { optionId: "reject_once", kind: "reject_once" },
          ],
        },
      });
    } else if (mode === "cancel") {
      return;
    } else if (mode === "cancel-timeout" && sessionId.endsWith("-1")) {
      return;
    } else if (mode === "cancel-timeout" && sessionId.endsWith("-2")) {
      setTimeout(() => finishPrompt(sessionId, "end_turn"), 2500);
    } else if (crashEnabled) {
      return;
    } else if (mode === "interleave" && sessionId.endsWith("-1")) {
      setTimeout(() => finishPrompt(sessionId, "end_turn"), INTERLEAVE_DELAY_MS);
    } else {
      finishPrompt(sessionId, "end_turn");
    }
    return;
  }
  if (message.method === "session/cancel") {
    if (mode === "cancel-timeout" && message.params.sessionId.endsWith("-1")) return;
    finishPrompt(message.params.sessionId, "cancelled");
    return;
  }
  if (message.method === "session/set_config_option") {
    const options = configOptions();
    const option = options.find((entry) => entry.id === message.params.configId);
    if (option) option.currentValue = message.params.value;
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: options } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  const sessionId = permissions.get(message.id);
  if (sessionId && message.result?.outcome) {
    finishPrompt(sessionId, message.result.outcome.outcome === "cancelled" ? "cancelled" : "end_turn");
  }
  if (message.id === initializeRequest?.id && message.error?.code === -32601) {
    send({ jsonrpc: "2.0", id: initializeRequest.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
});
