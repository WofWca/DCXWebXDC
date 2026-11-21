# DCXWebXDC

[Delta Chat](https://delta.chat) running inside of Delta Chat.

![A Delta Chat chat window on top of another Delta Chat chat window](https://repository-images.githubusercontent.com/1465412736/514853b2-8e6a-4bef-b908-652eea966123)

## How it works

The normal [Delta Chat Desktop](https://github.com/deltachat/deltachat-desktop)
is an Electron app, with a well-separated frontend component.
It uses the [Delta Chat Core](https://github.com/chatmail/core) binary
over its JSON-RPC server.
We replace the original Core with
[a mock version of it](./packages/target-webxdc/src/mock-core.ts)
that utilizes [WebXDC API](https://webxdc.org/docs/spec/api.html).
