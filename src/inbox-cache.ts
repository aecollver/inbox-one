import { readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { MessageRepository } from "./message";

const fetchMessageLimit = 100;

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

type AccountUidState = {
  server_id: string;
  username: string;
  min_seen_uid: number;
  max_seen_uid: number;
  updated_at: string;
};

export type AccountUidRange = {
  name: string;
  serverId: string;
  username: string;
  minSeenUid?: number;
  maxSeenUid?: number;
  updatedAt?: string;
};

export class InboxCache {
  private readonly db: Database.Database;
  private readonly messageRepository: MessageRepository;

  constructor(dbPath = path.resolve(process.cwd(), "inbox-cache.sqlite"), messageRepository = new MessageRepository()) {
    this.db = new Database(dbPath);
    this.messageRepository = messageRepository;
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_account_uid_state (
        server_id TEXT NOT NULL,
        username TEXT NOT NULL,
        min_seen_uid INTEGER NOT NULL,
        max_seen_uid INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, username)
      )
    `);
  }

  async fetchRecentMail(): Promise<void> {
    const credentials = await this.loadCredentials();

    for (const account of credentials.accounts) {
      await this.printRecentMessages(account);
    }
  }

  async backfillOldMail(): Promise<void> {
    console.log("backfilling old mail");
  }

  async listAccountUidRanges(): Promise<AccountUidRange[]> {
    const credentials = await this.loadCredentials();

    return credentials.accounts.map((account) => {
      const state = this.getAccountUidState(account);

      return {
        name: account.name,
        serverId: this.getServerId(account),
        username: account.username,
        minSeenUid: state?.min_seen_uid,
        maxSeenUid: state?.max_seen_uid,
        updatedAt: state?.updated_at,
      };
    });
  }

  close(): void {
    this.db.close();
  }

  private async loadCredentials(): Promise<CredentialsFile> {
    const credentialsPath = path.resolve(process.cwd(), "credentials.json");
    const contents = await readFile(credentialsPath, "utf8");
    const credentials = JSON.parse(contents) as CredentialsFile;

    if (!Array.isArray(credentials.accounts) || credentials.accounts.length === 0) {
      throw new Error("credentials.json must contain at least one account.");
    }

    return credentials;
  }

  private createClient(account: AccountConfig): ImapFlow {
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

  private async printRecentMessages(account: AccountConfig): Promise<void> {
    const client = this.createClient(account);

    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });

      try {
        const mailbox = client.mailbox;

        console.log(`\n${account.name} <${account.username}>`);

        if (!mailbox || mailbox.exists === 0) {
          console.log("No messages found.");
          return;
        }

        const startSequence = Math.max(1, mailbox.exists - fetchMessageLimit + 1);
        const messages = await client.fetchAll(`${startSequence}:*`, {
          uid: true,
          envelope: true,
          internalDate: true,
          source: true,
        });

        this.recordSeenUidRange(account, messages);
        const writtenMessageCount = await this.writeMessages(account, messages);
        console.log(`Saved ${writtenMessageCount} .eml files to ${this.messageRepository.getRootDir()}`);

        messages
          .sort((a, b) => b.seq - a.seq)
          .forEach((message, index) => {
            this.printMessageSummary(message, index + 1);
          });

        const state = this.getAccountUidState(account);
        if (state) {
          console.log(`Cached UID range: ${state.min_seen_uid}-${state.max_seen_uid}`);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  private recordSeenUidRange(account: AccountConfig, messages: FetchMessageObject[]): void {
    if (messages.length === 0) {
      return;
    }

    const uids = messages.map((message) => message.uid);
    const minSeenUid = Math.min(...uids);
    const maxSeenUid = Math.max(...uids);

    this.db
      .prepare(`
        INSERT INTO inbox_account_uid_state (server_id, username, min_seen_uid, max_seen_uid, updated_at)
        VALUES (@serverId, @username, @minSeenUid, @maxSeenUid, CURRENT_TIMESTAMP)
        ON CONFLICT(server_id, username) DO UPDATE SET
          min_seen_uid = MIN(inbox_account_uid_state.min_seen_uid, excluded.min_seen_uid),
          max_seen_uid = MAX(inbox_account_uid_state.max_seen_uid, excluded.max_seen_uid),
          updated_at = CURRENT_TIMESTAMP
      `)
      .run({
        serverId: this.getServerId(account),
        username: account.username,
        minSeenUid,
        maxSeenUid,
      });
  }

  private async writeMessages(account: AccountConfig, messages: FetchMessageObject[]): Promise<number> {
    let writtenMessageCount = 0;

    for (const message of messages) {
      if (!message.source) {
        continue;
      }

      const id = this.getMessageId(account, message.uid);
      await this.messageRepository.write({ id, raw: message.source });
      writtenMessageCount += 1;
    }

    return writtenMessageCount;
  }

  private getAccountUidState(account: AccountConfig): AccountUidState | undefined {
    return this.db
      .prepare<[string, string], AccountUidState>(`
        SELECT server_id, username, min_seen_uid, max_seen_uid, updated_at
        FROM inbox_account_uid_state
        WHERE server_id = ? AND username = ?
      `)
      .get(this.getServerId(account), account.username);
  }

  private getServerId(account: AccountConfig): string {
    return `${account.imap.host}:${account.imap.port}`;
  }

  private getMessageId(account: AccountConfig, uid: number): string {
    const prefix = `${this.getServerId(account)}-${account.username}`;
    const safePrefix = prefix.replace(/[^a-zA-Z0-9._@-]+/g, "-");

    return `${safePrefix}-${uid}`;
  }

  private printMessageSummary(message: FetchMessageObject, index: number): void {
    const envelope = message.envelope;
    const from = envelope?.from?.map((address) => address.address ?? address.name).filter(Boolean).join(", ") ?? "(unknown sender)";
    const subject = envelope?.subject ?? "(no subject)";
    const date = envelope?.date ?? message.internalDate;
    const formattedDate = date instanceof Date ? date.toISOString() : date ?? "unknown date";

    console.log(`${index}. [uid ${message.uid}] ${from} - ${subject} (${formattedDate})`);
  }
}
