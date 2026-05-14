import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  previewRetentionRules,
  type AccountConfig,
  type FolderPolicyRulePreview,
  type SkippedPolicyPreview,
} from "./preview-retention";
import {
  previewSelectionCandidates,
  type PolicySelectionCandidatePreview,
} from "./preview-selection";
import { PolicyRepository, type Policy } from "./repository";

const retentionPreviewEnabled = process.env.POLICY_RETENTION_PREVIEW_ENABLED === "1";

export type {
  FolderPolicyRulePreview,
  SkippedPolicyPreview,
} from "./preview-retention";
export type { PolicySelectionCandidatePreview } from "./preview-selection";

type CredentialsFile = {
  accounts: AccountConfig[];
};

export type PolicyPreview = {
  generatedAt: string;
  connectionId?: string;
  folderPath?: string;
  rules: FolderPolicyRulePreview[];
  selectionCandidates: PolicySelectionCandidatePreview[];
  selectionPolicyCount: number;
  skippedFolders: FolderPolicyRulePreview[];
  skippedPolicies: SkippedPolicyPreview[];
};

export type PolicyPreviewFilter = {
  connectionId?: string;
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printSelectionCriteria(rules: FolderPolicyRulePreview[]): void {
  const rulesWithSelectionCriteria = rules.filter((rule) => rule.selectionCriteria?.trim());

  if (rulesWithSelectionCriteria.length === 0) {
    return;
  }

  console.log("Selection criteria:");
  for (const rule of rulesWithSelectionCriteria) {
    console.log(`  ${rule.accountName}/${rule.folder}: ${rule.selectionCriteria}`);
  }
}

async function previewAccount(account: AccountConfig, policies: Policy[]): Promise<{
  rules: FolderPolicyRulePreview[];
  selectionCandidates: PolicySelectionCandidatePreview[];
  skippedFolders: FolderPolicyRulePreview[];
  skippedPolicies: SkippedPolicyPreview[];
}> {
  const skippedPolicies: SkippedPolicyPreview[] = [];
  let selectionCandidates: PolicySelectionCandidatePreview[] = [];

  try {
    selectionCandidates = await previewSelectionCandidates(account, policies);
  } catch (error: unknown) {
    skippedPolicies.push(...policies
      .filter((policy) => policy.selectionCriteria?.trim())
      .map((policy) => ({
        connectionId: policy.connectionId,
        folderPath: policy.folderPath,
        reason: `selection criteria preview failed: ${getErrorMessage(error)}`,
      })));
  }

  const retentionPreview = retentionPreviewEnabled
    ? await previewRetentionRules(account, policies)
    : {
      rules: [],
      skippedFolders: [],
      skippedPolicies: [],
    };

  return {
    rules: retentionPreview.rules,
    selectionCandidates,
    skippedFolders: retentionPreview.skippedFolders,
    skippedPolicies: [
      ...skippedPolicies,
      ...retentionPreview.skippedPolicies,
    ],
  };
}

export async function createPolicyPreview(filter: PolicyPreviewFilter = {}): Promise<PolicyPreview> {
  const credentials = await loadCredentials();
  const policyRepository = new PolicyRepository();
  const policies = policyRepository.listPolicies(filter);
  policyRepository.close();

  const preview: PolicyPreview = {
    generatedAt: new Date().toISOString(),
    connectionId: filter.connectionId,
    folderPath: filter.folderPath,
    rules: [],
    selectionCandidates: [],
    selectionPolicyCount: policies.filter((policy) => policy.selectionCriteria?.trim()).length,
    skippedFolders: [],
    skippedPolicies: [],
  };

  const policiesByConnection = new Map<string, Policy[]>();

  for (const policy of policies) {
    const connectionPolicies = policiesByConnection.get(policy.connectionId) ?? [];
    connectionPolicies.push(policy);
    policiesByConnection.set(policy.connectionId, connectionPolicies);
  }

  for (const [connectionId, connectionPolicies] of policiesByConnection) {
    const account = credentials.accounts.find((candidate) => candidate.name === connectionId);

    if (!account) {
      preview.skippedPolicies.push(...connectionPolicies.map((policy) => ({
        connectionId: policy.connectionId,
        folderPath: policy.folderPath,
        reason: "connection not found",
      })));
      continue;
    }

    const accountPreview = await previewAccount(account, connectionPolicies);
    preview.rules.push(...accountPreview.rules);
    preview.selectionCandidates.push(...accountPreview.selectionCandidates);
    preview.skippedFolders.push(...accountPreview.skippedFolders);
    preview.skippedPolicies.push(...accountPreview.skippedPolicies);
  }

  preview.rules.sort((a, b) =>
    a.accountName.localeCompare(b.accountName) || a.folder.localeCompare(b.folder),
  );
  preview.skippedFolders.sort((a, b) =>
    a.accountName.localeCompare(b.accountName) || a.folder.localeCompare(b.folder),
  );
  preview.skippedPolicies.sort((a, b) =>
    a.connectionId.localeCompare(b.connectionId) || a.folderPath.localeCompare(b.folderPath),
  );
  preview.selectionCandidates.sort((a, b) =>
    a.accountName.localeCompare(b.accountName)
    || a.folder.localeCompare(b.folder)
    || a.subject.localeCompare(b.subject),
  );

  return preview;
}

export function printPolicyPreview(preview: PolicyPreview): void {
  console.log(`Policy preview generated at ${preview.generatedAt}`);
  console.log("Rule: delete messages older than each configured policy retentionDays value");
  if (preview.connectionId || preview.folderPath) {
    console.log(`Filter: connection=${preview.connectionId ?? "*"} folder=${preview.folderPath ?? "*"}`);
  }

  if (
    preview.rules.length === 0
    && preview.selectionCandidates.length === 0
    && preview.skippedFolders.length === 0
    && preview.skippedPolicies.length === 0
  ) {
    console.log("No policies configured.");
    return;
  }

  if (preview.rules.length > 0) {
    console.table(preview.rules.map((rule) => ({
      account: rule.accountName,
      provider: rule.provider,
      folder: rule.folder,
      retentionDays: rule.retentionDays,
      cutoffDate: rule.cutoffDate,
      totalMessages: rule.totalMessages,
      wouldDelete: rule.oldMessagesMayBeCapped ? `>=${rule.oldMessages}` : rule.oldMessages,
    })));
    printSelectionCriteria(preview.rules);
  }

  const totalOldMessages = preview.rules.reduce((total, rule) => total + rule.oldMessages, 0);
  const hasCappedCounts = preview.rules.some((rule) => rule.oldMessagesMayBeCapped);
  console.log(`Total messages that would be deleted: ${hasCappedCounts ? ">=" : ""}${totalOldMessages}`);

  if (preview.selectionCandidates.length > 0) {
    console.log("Messages that would be moved by selection criteria:");
    console.table(preview.selectionCandidates.map((candidate) => ({
      connectionId: candidate.connectionId,
      account: candidate.accountName,
      folder: candidate.folder,
      messageId: candidate.messageId,
      from: candidate.from ?? "(unknown sender)",
      subject: candidate.subject,
      date: candidate.date ?? "-",
      reason: candidate.reason,
    })));
  } else if (preview.selectionPolicyCount > 0) {
    console.log("No local messages matched policy selection criteria.");
  }

  if (preview.skippedFolders.length > 0) {
    console.log("Skipped non-selectable folders:");
    for (const folder of preview.skippedFolders) {
      console.log(`  ${folder.accountName}/${folder.provider}/${folder.folder}`);
    }
  }

  if (preview.skippedPolicies.length > 0) {
    console.log("Skipped policies:");
    for (const policy of preview.skippedPolicies) {
      console.log(`  ${policy.connectionId}/${policy.folderPath}: ${policy.reason}`);
    }
  }
}
