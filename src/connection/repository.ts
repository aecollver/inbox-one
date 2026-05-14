import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Connection = {
  name: string;
  username: string;
  appPassword: string;
  imap: MailServerConfig;
  smtp?: MailServerConfig;
};

export type MailServerConfig = {
  host: string;
  port: number;
  tls: boolean;
};

type ConnectionsFile = {
  connections: Connection[];
};

export function getConnectionsPath(): string {
  return path.join(os.homedir(), ".inbox-one", "connections.json");
}

export class ConnectionRepository {
  constructor(private readonly connectionsPath = getConnectionsPath()) {}

  async list(): Promise<Connection[]> {
    return (await this.load()).connections;
  }

  async findByName(name: string): Promise<Connection | undefined> {
    return (await this.list()).find((connection) => connection.name === name);
  }

  private async load(): Promise<ConnectionsFile> {
    const contents = await readFile(this.connectionsPath, "utf8");
    const connections = JSON.parse(contents) as ConnectionsFile;

    if (!Array.isArray(connections.connections) || connections.connections.length === 0) {
      throw new Error(`${this.connectionsPath} must contain at least one connection.`);
    }

    return connections;
  }
}
