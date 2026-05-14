#!/usr/bin/env node

import { classifyRecentMail } from "../classify";
import { listFolders, printFolders } from "../folder";
import { InboxCache, type AccountUidRange } from "../inbox-cache";
import { createPolicyPreview, PolicyRepository, printPolicyPreview, type Policy } from "../policy";
import { listConnections, printConnections } from "./connection-list";

function printUsage(): void {
  console.log(`Usage: npm run cli -- <command>

Commands:
  ls accounts       List configured accounts and seen UID ranges
  fetch             Fetch recent mail and write .eml files
  classify          Classify recent mail with Ollama
  connection ls     List configured connections
  folder ls <name>  List folders for a connection
  policy ls [connection id] [folder]
                    List configured policies
  policy set <connection id> <folder> <retention days> [selection criteria]
                    Set a folder retention policy
  policy remove <connection id> <folder>
                    Remove a folder retention policy
  policy preview [connection id] [folder]
                    Preview policy cleanup rules`);
}

function formatUidRange(account: AccountUidRange): string {
  if (account.minSeenUid === undefined || account.maxSeenUid === undefined) {
    return "(none)";
  }

  return `${account.minSeenUid}-${account.maxSeenUid}`;
}

function printAccountUidRanges(accounts: AccountUidRange[]): void {
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    return;
  }

  const rows = accounts.map((account) => ({
    account: `${account.name} <${account.username}>`,
    server: account.serverId,
    seenUidRange: formatUidRange(account),
    updatedAt: account.updatedAt ?? "-",
  }));

  console.table(rows);
}

function printPolicies(policies: Policy[]): void {
  if (policies.length === 0) {
    console.log("No policies configured.");
    return;
  }

  console.table(policies.map((policy) => ({
    connectionId: policy.connectionId,
    folder: policy.folderPath,
    retentionDays: policy.retentionDays,
    selectionCriteria: policy.selectionCriteria ?? "-",
    updatedAt: policy.updatedAt,
  })));
}

function printPolicy(policy: Policy): void {
  console.table([{
    connectionId: policy.connectionId,
    folder: policy.folderPath,
    retentionDays: policy.retentionDays,
    selectionCriteria: policy.selectionCriteria ?? "-",
    updatedAt: policy.updatedAt,
  }]);
}

function parseRetentionDays(value: string | undefined): number {
  const retentionDays = Number(value);

  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error("retention days must be a non-negative integer.");
  }

  return retentionDays;
}

function findRetentionDaysIndex(command: string[]): number {
  for (let index = command.length - 1; index >= 4; index -= 1) {
    if (Number.isInteger(Number(command[index]))) {
      return index;
    }
  }

  throw new Error("retention days must be provided as a non-negative integer.");
}

async function main(): Promise<void> {
  const command = process.argv.slice(2);

  if (command.length === 0 || command[0] === "help" || command[0] === "--help" || command[0] === "-h") {
    printUsage();
    return;
  }

  if (command[0] === "ls" && command[1] === "accounts" && command.length === 2) {
    const inboxCache = new InboxCache();

    try {
      printAccountUidRanges(await inboxCache.listAccountUidRanges());
    } finally {
      inboxCache.close();
    }

    return;
  }

  if (command[0] === "fetch" && command.length === 1) {
    const inboxCache = new InboxCache();

    try {
      await inboxCache.fetchRecentMail();
    } finally {
      inboxCache.close();
    }

    return;
  }

  if (command[0] === "classify" && command.length === 1) {
    await classifyRecentMail();
    return;
  }

  if (command[0] === "connection" && command[1] === "ls" && command.length === 2) {
    printConnections(await listConnections());
    return;
  }

  if (command[0] === "folder" && command[1] === "ls" && command.length === 3) {
    printFolders(await listFolders(command[2]));
    return;
  }

  if (command[0] === "policy" && command[1] === "ls" && command.length >= 2) {
    const policyRepository = new PolicyRepository();
    const connectionId = command[2];
    const folderPath = command.slice(3).join(" ") || undefined;

    try {
      printPolicies(policyRepository.listPolicies({ connectionId, folderPath }));
    } finally {
      policyRepository.close();
    }

    return;
  }

  if (command[0] === "policy" && command[1] === "set" && command.length >= 5) {
    const policyRepository = new PolicyRepository();
    const connectionId = command[2];
    const retentionDaysIndex = findRetentionDaysIndex(command);
    const retentionDays = parseRetentionDays(command[retentionDaysIndex]);
    const folderPath = command.slice(3, retentionDaysIndex).join(" ");
    const selectionCriteria = command.slice(retentionDaysIndex + 1).join(" ") || undefined;

    try {
      printPolicy(policyRepository.setPolicy({ connectionId, folderPath, retentionDays, selectionCriteria }));
    } finally {
      policyRepository.close();
    }

    return;
  }

  if (command[0] === "policy" && command[1] === "remove" && command.length >= 4) {
    const policyRepository = new PolicyRepository();
    const connectionId = command[2];
    const folderPath = command.slice(3).join(" ");

    try {
      const removed = policyRepository.removePolicy(connectionId, folderPath);
      console.log(removed ? "Policy removed." : "No matching policy found.");
    } finally {
      policyRepository.close();
    }

    return;
  }

  if (command[0] === "policy" && command[1] === "preview" && command.length >= 2) {
    const connectionId = command[2];
    const folderPath = command.slice(3).join(" ") || undefined;
    printPolicyPreview(await createPolicyPreview({ connectionId, folderPath }));
    return;
  }

  console.error(`Unknown command: ${command.join(" ")}`);
  printUsage();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
