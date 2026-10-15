// `ws` is resolved from packages/kilo-vscode when the fixture is bundled; this package does not depend on it.
declare module "ws" {
  export default class WebSocket {
    constructor(url: string)
  }
}
