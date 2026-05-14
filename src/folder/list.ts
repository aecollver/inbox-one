import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImapFlow, type ListResponse } from "imapflow";

type MailServerConfig = {
  host: string;
  port: number;
  tls: boolean;
};

type AccountConfig = {
  name: string;
  username: string;
  appPassword: string;
  imap: MailServerConfig;
};

type CredentialsFile = {
  accounts: AccountConfig[];
};

export type Folder = {
  path: string;
  name: string;
  specialUse?: string;
  selectable: boolean;
  messages?: number;
  unseen?: number;
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

function createClient(account: AccountConfig): ImapFlow {
  if (!account.username || !account.appPassword) {
    throw new Error(`Account "${account.name}" is missing username or appPassword.`);
  }

  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    servername: account.imap.host,
    auth: {
      user: account.username,
      pass: account.appPassword,
    },
    logger: false,
  });
}

function isSelectableFolder(folder: ListResponse): boolean {
  return !folder.flags.has("\\Noselect") && !folder.flags.has("\\NonExistent");
}

function toFolder(folder: ListResponse): Folder {
  return {
    path: folder.path,
    name: folder.name,
    specialUse: folder.specialUse,
    selectable: isSelectableFolder(folder),
    messages: folder.status?.messages,
    unseen: folder.status?.unseen,
  };
}

export async function listFolders(connectionName: string): Promise<Folder[]> {
  const credentials = await loadCredentials();
  const account = credentials.accounts.find((candidate) => candidate.name === connectionName);

  if (!account) {
    throw new Error(`Connection "${connectionName}" was not found.`);
  }

  const client = createClient(account);

  try {
    await client.connect();
    const folders = await client.list({
      statusQuery: {
        messages: true,
        unseen: true,
      },
    });

    return folders
      .map(toFolder)
      .sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    await client.logout();
  }
}

export function printFolders(folders: Folder[]): void {
  if (folders.length === 0) {
    console.log("No folders found.");
    return;
  }

  console.table(folders.map((folder) => ({
    path: folder.path,
    specialUse: folder.specialUse ?? "-",
    selectable: folder.selectable,
    messages: folder.messages ?? "-",
    unseen: folder.unseen ?? "-",
  })));
}
