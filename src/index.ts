import { readFile } from "node:fs/promises";
import path from "node:path";
import Imap from "imap";
import { classifyEmail } from "./ollama";

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
  smtp: MailServerConfig;
};

type CredentialsFile = {
  accounts: AccountConfig[];
};

type MessageSummary = {
  uid: number;
  from?: string;
  subject: string;
  date?: string;
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

function createImap(account: AccountConfig): Imap {
  if (!account.username || !account.appPassword) {
    throw new Error(`Account "${account.name}" is missing username or appPassword.`);
  }

  return new Imap({
    user: account.username,
    password: account.appPassword,
    host: account.imap.host,
    port: account.imap.port,
    tls: account.imap.tls,
    tlsOptions: {
      servername: account.imap.host,
    },
  });
}

function connect(imap: Imap): Promise<void> {
  return new Promise((resolve, reject) => {
    imap.once("ready", resolve);
    imap.once("error", reject);
    imap.connect();
  });
}

function openInbox(imap: Imap): Promise<Imap.Box> {
  return new Promise((resolve, reject) => {
    imap.openBox("INBOX", true, (error, box) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(box);
    });
  });
}

function searchAllMessages(imap: Imap): Promise<number[]> {
  return new Promise((resolve, reject) => {
    imap.search(["ALL"], (error, uids) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(uids);
    });
  });
}

function fetchSubjects(imap: Imap, uids: number[]): Promise<MessageSummary[]> {
  return new Promise((resolve, reject) => {
    if (uids.length === 0) {
      resolve([]);
      return;
    }

    const messages = new Map<number, MessageSummary>();
    const fetch = imap.fetch(uids, {
      bodies: "HEADER.FIELDS (FROM SUBJECT DATE)",
      markSeen: false,
    });

    fetch.on("message", (message) => {
      let uid: number | undefined;
      let from: string | undefined;
      let subject = "(no subject)";
      let date: string | undefined;

      message.on("body", (stream) => {
        let buffer = "";

        stream.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
        });

        stream.once("end", () => {
          const parsed = Imap.parseHeader(buffer);
          from = parsed.from?.[0];
          subject = parsed.subject?.[0] ?? "(no subject)";
          date = parsed.date?.[0];
        });
      });

      message.once("attributes", (attributes) => {
        uid = attributes.uid;
      });

      message.once("end", () => {
        if (uid !== undefined) {
          messages.set(uid, { uid, from, subject, date });
        }
      });
    });

    fetch.once("error", reject);
    fetch.once("end", () => {
      resolve([...messages.values()].sort((a, b) => b.uid - a.uid));
    });
  });
}

async function printRecentClassifications(account: AccountConfig): Promise<void> {
  const imap = createImap(account);

  try {
    await connect(imap);
    await openInbox(imap);

    const allUids = await searchAllMessages(imap);
    const recentUids = allUids.sort((a, b) => b - a).slice(0, 10);
    const messages = await fetchSubjects(imap, recentUids);

    console.log(`\n${account.name} <${account.username}>`);

    if (messages.length === 0) {
      console.log("No messages found.");
      return;
    }

    for (const [index, message] of messages.entries()) {
      const classification = await classifyEmail({
        accountName: account.name,
        from: message.from,
        subject: message.subject,
        date: message.date,
      });

      console.log(
        `${index + 1}. [${classification.priority}] ${classification.category}: ${message.subject}`,
      );
      console.log(`   ${classification.reason}`);
    }
  } finally {
    imap.end();
  }
}

async function main(): Promise<void> {
  const credentials = await loadCredentials();

  for (const account of credentials.accounts) {
    await printRecentClassifications(account);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
