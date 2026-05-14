#!/usr/bin/env node

import { InboxCache, type AccountUidRange } from "./inbox-cache";
import { classifyRecentMail } from "./classify";
import { listConnections, printConnections } from "./connection";
import { listFolders, printFolders } from "./folder";
import { createPolicyPreview, printPolicyPreview } from "./policy";

function printUsage(): void {
  console.log(`Usage: npm run cli -- <command>

Commands:
  ls accounts       List configured accounts and seen UID ranges
  fetch             Fetch recent mail and write .eml files
  classify          Classify recent mail with Ollama
  connection ls     List configured connections
  folder ls <name>  List folders for a connection
  policy preview [account] [folder]
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

  if (command[0] === "policy" && command[1] === "preview" && command.length >= 2) {
    const accountName = command[2];
    const folderPath = command.slice(3).join(" ") || undefined;
    printPolicyPreview(await createPolicyPreview({ accountName, folderPath }));
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
