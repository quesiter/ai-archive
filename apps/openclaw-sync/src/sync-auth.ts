export class AuthenticationRevoked extends Error {
  constructor() {
    super(
      "AUTH_REVOKED: device authorization is invalid; pair this agent again. " +
      "On macOS, choose launcher option 5 or run ./AI-Archive-Sync.command pair. " +
      "For the agent CLI, use pair --preserve-config --code <new-pairing-code>.",
    );
    this.name = "AuthenticationRevoked";
  }
}
