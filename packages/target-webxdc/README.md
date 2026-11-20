# Delta Chat as a WebXDC app

Runs the Delta Chat frontend inside Delta Chat, as a `.xdc` app.

There is no core: `src/mock-core.ts` answers the frontend's JSON-RPC calls in the page.
It has one account and one group chat. Every message is a WebXDC status update,
so everyone in the real chat where the app was shared sees it.

Only text messages work. Unsupported RPC methods are rejected with
"... is not supported in the WebXDC version". To support more of the UI, add
handlers to `MockCore.handlers`.

```sh
pnpm build:webxdc            # from the repo root -> packages/target-webxdc/dist/deltachat.xdc
pnpm --filter=@deltachat-desktop/target-webxdc test
```

To try it without Delta Chat, serve `dist/app/` with any WebXDC simulator, for example
[webxdc-dev](https://github.com/webxdc/webxdc-dev).
