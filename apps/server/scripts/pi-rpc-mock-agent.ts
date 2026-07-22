let buffered = "";
let sessionId = process.env.PI_MOCK_SESSION_ID ?? "fresh-session";
let sessionFile = process.env.PI_MOCK_SESSION_FILE ?? "/tmp/pi-fresh-session.jsonl";
let thinkingLevel = "medium";
let promptCount = 0;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);

    if (command.type === "get_state" && process.env.PI_MOCK_DROP_GET_STATE === "1") {
      continue;
    }
    if (command.type === "abort" && process.env.PI_MOCK_EXIT_ON_ABORT === "1") {
      process.exit(17);
    }
    if (command.type === "switch_session") {
      sessionId = "resumed-session";
      sessionFile = command.sessionPath;
    }
    if (command.type === "set_thinking_level") {
      thinkingLevel = process.env.PI_MOCK_THINKING_APPLIED ?? command.level;
    }
    if (command.type === "prompt") {
      promptCount += 1;
      process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
      process.stdout.write(
        `${JSON.stringify({
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ type: "agent_end", messages: [], willRetry: false })}\n`,
      );
      if (process.env.PI_MOCK_HOLD_SETTLE !== "1" || promptCount > 1) {
        process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      }
    }

    const data =
      command.type === "get_state"
        ? {
            sessionId,
            sessionFile,
            thinkingLevel,
            isStreaming: false,
            model: {
              provider: "test",
              id: "model",
              name: "Test Model",
              reasoning: true,
              input: ["text", "image"],
            },
          }
        : command.type === "switch_session"
          ? { cancelled: false }
          : command.type === "get_entries"
            ? process.env.PI_MOCK_FRESH_EMPTY === "1" && !command.since
              ? { entries: [], leafId: null }
              : command.since === "entry-1"
                ? {
                    entries: [
                      ...(process.env.PI_MOCK_LEGACY_SESSION_INFO === "1"
                        ? [
                            {
                              type: "session_info",
                              timestamp: "2026-01-01T00:00:00.000Z",
                              name: "Legacy title",
                            },
                          ]
                        : []),
                      {
                        type: "message",
                        id: "entry-2",
                        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
                      },
                    ],
                    leafId: "entry-2",
                  }
                : {
                    entries: [
                      {
                        type: "message",
                        id: "entry-1",
                        message: { role: "assistant", content: [{ type: "text", text: "one" }] },
                      },
                    ],
                    leafId: "entry-1",
                  }
            : command.type === "set_model"
              ? {
                  provider: command.provider,
                  id: command.modelId,
                  name: command.modelId,
                  reasoning: true,
                  input: ["text", "image"],
                }
              : undefined;

    process.stdout.write(
      `${JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        data,
      })}\n`,
    );
  }
});
