import { ConnectionRepository, type Connection } from "../connection/repository";

export async function listConnections(): Promise<Connection[]> {
  const connectionRepository = new ConnectionRepository();

  return connectionRepository.list();
}

export function printConnections(connections: Connection[]): void {
  if (connections.length === 0) {
    console.log("No connections configured.");
    return;
  }

  console.table(connections.map((connection) => ({
    account: connection.name,
    username: connection.username,
    inbound: formatEndpoint(connection.imap.host, connection.imap.port),
    outbound: connection.smtp
      ? formatEndpoint(connection.smtp.host, connection.smtp.port)
      : "-",
  })));
}

function formatEndpoint(host: string, port: number): string {
  return `${host}:${port}`;
}
