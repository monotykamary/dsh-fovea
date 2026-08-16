export class ClientConnection {
  private switchingServers = false;

  async connectToServer(): Promise<void> {
    this.switchingServers = true;
  }
}
