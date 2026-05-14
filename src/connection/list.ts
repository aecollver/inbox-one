import { readFile } from "node:fs/promises";
import path from "node:path";

type MailServerConfig = {
  host: string;
  port: number;
  tls: boolean;
};

type AccountConfig = {
  name: string;
  username: string;
  imap: MailServerConfig;
  smtp?: MailServerConfig;
};

type CredentialsFile = {
  accounts: AccountConfig[];
};

export type Connection = {
  account: string;
  username: string;
  inboundHost: string;
  inboundPort: number;
  inboundTls: boolean;
  outboundHost?: string;
  outboundPort?: number;
  outboundTls?: boolean;
};

async function loadCredentials(): Promise<CredentialsFile> {
  const credentialsPath = path.resolve(process.cwd(), "credentials.json");
  const contents = await readFile(credentialsPath, "utf8");
  const credentials = JSON.parse(contents) as CredentialsFile;

  if (!Array.isArray(credentials.accounts) || credentials.accounts.length === 0) {
    throw new Error("credentials.json must contain at least one account.");
  }

  return credentials;
}

function toConnection(account: AccountConfig): Connection {
  return {
    account: account.name,
    username: account.username,
    inboundHost: account.imap.host,
    inboundPort: account.imap.port,
    inboundTls: account.imap.tls,
    outboundHost: account.smtp?.host,
    outboundPort: account.smtp?.port,
    outboundTls: account.smtp?.tls,
  };
}

export async function listConnections(): Promise<Connection[]> {
  const credentials = await loadCredentials();

  return credentials.accounts.map(toConnection);
}

export function printConnections(connections: Connection[]): void {
  if (connections.length === 0) {
    console.log("No connections configured.");
    return;
  }

  console.table(connections.map((connection) => ({
    account: connection.account,
    username: connection.username,
    inbound: formatEndpoint(connection.inboundHost, connection.inboundPort),
    outbound: connection.outboundHost && connection.outboundPort !== undefined && connection.outboundTls !== undefined
      ? formatEndpoint(connection.outboundHost, connection.outboundPort)
      : "-",
  })));
}

function formatEndpoint(host: string, port: number): string {
  return `${host}:${port}`;
}
