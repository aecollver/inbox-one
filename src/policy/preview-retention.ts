import { ImapFlow, type ESearchResult, type ListResponse } from "imapflow";
import type { Policy } from "./repository";

export type MailServerConfig = {
  host: string;
  port: number;
  tls: boolean;
};

export type AccountConfig = {
  name: string;
  username: string;
  appPassword: string;
  imap: MailServerConfig;
};

export type FolderPolicyRulePreview = {
  accountName: string;
  username: string;
  provider: string;
  folder: string;
  retentionDays: number;
  selectionCriteria?: string;
  cutoffDate: string;
  totalMessages: number;
  oldMessages: number;
  oldMessagesMayBeCapped: boolean;
};

export type SkippedPolicyPreview = {
  connectionId: string;
  folderPath: string;
  reason: string;
};

export type RetentionPreviewResult = {
  rules: FolderPolicyRulePreview[];
  skippedFolders: FolderPolicyRulePreview[];
  skippedPolicies: SkippedPolicyPreview[];
};

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
  policy: Policy,
): FolderPolicyRulePreview {
  const cutoffDate = getCutoffDate(policy.retentionDays);

  return {
    accountName: account.name,
    username: account.username,
    provider: account.imap.host,
    folder: folder.path,
    retentionDays: policy.retentionDays,
    selectionCriteria: policy.selectionCriteria,
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

export async function previewRetentionRules(
  account: AccountConfig,
  policies: Policy[],
): Promise<RetentionPreviewResult> {
  const client = createClient(account);
  const rules: FolderPolicyRulePreview[] = [];
  const skippedFolders: FolderPolicyRulePreview[] = [];
  const skippedPolicies: SkippedPolicyPreview[] = [];

  try {
    await client.connect();
    const folders = await client.list({ statusQuery: { messages: true } });

    for (const policy of policies) {
      const folder = folders.find((candidate) => candidate.path === policy.folderPath);

      if (!folder) {
        skippedPolicies.push({
          connectionId: policy.connectionId,
          folderPath: policy.folderPath,
          reason: "folder not found",
        });
        continue;
      }

      if (!isSelectableFolder(folder)) {
        skippedFolders.push(createRulePreview(account, folder, 0, policy));
        continue;
      }

      const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });

      try {
        const cutoffDate = getCutoffDate(policy.retentionDays);
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
          policy,
        ));
      } finally {
        await client.mailboxClose();
      }
    }
  } finally {
    await client.logout();
  }

  return { rules, skippedFolders, skippedPolicies };
}
