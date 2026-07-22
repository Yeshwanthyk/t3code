let buffered = "";

function write(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

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

    if (command.type === "extension_ui_response") {
      write({
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_delta",
          delta: JSON.stringify(command),
        },
      });
      write({ type: "agent_settled" });
      continue;
    }

    if (command.type === "prompt") {
      write({ type: "agent_start" });
      if (process.env.PI_MOCK_UI_METHOD === "confirm") {
        write({
          type: "extension_ui_request",
          id: "pi-confirm-1",
          method: "confirm",
          title: "Proceed?",
          message: "Confirm the operation.",
        });
      } else {
        write({
          type: "extension_ui_request",
          id: "pi-input-1",
          method: "input",
          title: "Enter a value",
          placeholder: "value",
        });
      }
    }

    const data =
      command.type === "get_state"
        ? {
            sessionId: "extension-ui-session",
            sessionFile: "/tmp/pi-extension-ui-session.jsonl",
            thinkingLevel: "medium",
            isStreaming: false,
            model: {
              provider: "test",
              id: "model",
              name: "Test Model",
              reasoning: true,
              input: ["text"],
            },
          }
        : command.type === "get_entries"
          ? { entries: [], leafId: null }
          : undefined;
    write({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data,
    });
  }
});
