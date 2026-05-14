import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImapFlow, type ESearchResult, type ListResponse } from "imapflow";

const defaultRetentionDays = 365;

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

export type FolderPolicyRulePreview = {
  accountName: string;
  username: string;
  provider: string;
  folder: string;
  retentionDays: number;
  cutoffDate: string;
  totalMessages: number;
  oldMessages: number;
  oldMessagesMayBeCapped: boolean;
};

export type PolicyPreview = {
  generatedAt: string;
  accountName?: string;
  folderPath?: string;
  rules: FolderPolicyRulePreview[];
  skippedFolders: FolderPolicyRulePreview[];
};

export type PolicyPreviewFilter = {
  accountName?: string;
  folderPath?: string;
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

function getCutoffDate(retentionDays: number): Date {
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays);
  cutoffDate.setUTCHours(0, 0, 0, 0);

  return cutoffDate;
}

function isSelectableFolder(folder: ListResponse): boolean {
  return !folder.flags.has("\\Noselect") && !folder.flags.has("\\NonExistent");
}

function createRulePreview(
  account: AccountConfig,
  folder: ListResponse,
  oldMessages: number,
): FolderPolicyRulePreview {
  const cutoffDate = getCutoffDate(defaultRetentionDays);

  return {
    accountName: account.name,
    username: account.username,
    provider: account.imap.host,
    folder: folder.path,
    retentionDays: defaultRetentionDays,
    cutoffDate: cutoffDate.toISOString().slice(0, 10),
    totalMessages: folder.status?.messages ?? 0,
    oldMessages,
    oldMessagesMayBeCapped: oldMessages === 1000 && (folder.status?.messages ?? 0) > oldMessages,
  };
}

function getSearchCount(searchResult: ESearchResult | number[] | false): number {
  if (!searchResult) {
    return 0;
  }

  if (Array.isArray(searchResult)) {
    return searchResult.length;
  }

  return searchResult.count ?? 0;
}

async function previewAccount(account: AccountConfig, filter: PolicyPreviewFilter): Promise<{
  rules: FolderPolicyRulePreview[];
  skippedFolders: FolderPolicyRulePreview[];
}> {
  const client = createClient(account);
  const cutoffDate = getCutoffDate(defaultRetentionDays);
  const rules: FolderPolicyRulePreview[] = [];
  const skippedFolders: FolderPolicyRulePreview[] = [];

  try {
    await client.connect();
    const folders = (await client.list({ statusQuery: { messages: true } }))
      .filter((folder) => !filter.folderPath || folder.path === filter.folderPath);

    if (filter.folderPath && folders.length === 0) {
      throw new Error(`Folder "${filter.folderPath}" was not found for connection "${account.name}".`);
    }

    for (const folder of folders) {
      if (!isSelectableFolder(folder)) {
        skippedFolders.push(createRulePreview(account, folder, 0));
        continue;
      }

      const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });

      try {
        const oldMessageCount = mailbox.exists > 0
          ? getSearchCount(await client.search({ before: cutoffDate }, {
            uid: true,
            returnOptions: ["COUNT"],
          }))
          : 0;

        rules.push(createRulePreview(
          account,
          folder,
          oldMessageCount,
        ));
      } finally {
        await client.mailboxClose();
      }
    }
  } finally {
    await client.logout();
  }

  return { rules, skippedFolders };
}

export async function createPolicyPreview(filter: PolicyPreviewFilter = {}): Promise<PolicyPreview> {
  const credentials = await loadCredentials();
  const accounts = filter.accountName
    ? credentials.accounts.filter((account) => account.name === filter.accountName)
    : credentials.accounts;

  if (filter.accountName && accounts.length === 0) {
    throw new Error(`Connection "${filter.accountName}" was not found.`);
  }

  const preview: PolicyPreview = {
    generatedAt: new Date().toISOString(),
    accountName: filter.accountName,
    folderPath: filter.folderPath,
    rules: [],
    skippedFolders: [],
  };

  for (const account of accounts) {
    const accountPreview = await previewAccount(account, filter);
    preview.rules.push(...accountPreview.rules);
    preview.skippedFolders.push(...accountPreview.skippedFolders);
  }

  preview.rules.sort((a, b) =>
    a.accountName.localeCompare(b.accountName) || a.folder.localeCompare(b.folder),
  );
  preview.skippedFolders.sort((a, b) =>
    a.accountName.localeCompare(b.accountName) || a.folder.localeCompare(b.folder),
  );

  return preview;
}

export function printPolicyPreview(preview: PolicyPreview): void {
  console.log(`Policy preview generated at ${preview.generatedAt}`);
  console.log(`Rule: delete messages older than ${defaultRetentionDays} days per account/provider/folder`);
  if (preview.accountName || preview.folderPath) {
    console.log(`Filter: account=${preview.accountName ?? "*"} folder=${preview.folderPath ?? "*"}`);
  }

  if (preview.rules.length === 0) {
    console.log("No matching selectable folders found.");
    return;
  }

  console.table(preview.rules.map((rule) => ({
    account: rule.accountName,
    provider: rule.provider,
    folder: rule.folder,
    retentionDays: rule.retentionDays,
    cutoffDate: rule.cutoffDate,
    totalMessages: rule.totalMessages,
    wouldDelete: rule.oldMessagesMayBeCapped ? `>=${rule.oldMessages}` : rule.oldMessages,
  })));

  const totalOldMessages = preview.rules.reduce((total, rule) => total + rule.oldMessages, 0);
  const hasCappedCounts = preview.rules.some((rule) => rule.oldMessagesMayBeCapped);
  console.log(`Total messages that would be deleted: ${hasCappedCounts ? ">=" : ""}${totalOldMessages}`);

  if (preview.skippedFolders.length > 0) {
    console.log("Skipped non-selectable folders:");
    for (const folder of preview.skippedFolders) {
      console.log(`  ${folder.accountName}/${folder.provider}/${folder.folder}`);
    }
  }
}
