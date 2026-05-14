import { MessageRepository } from "../message";
import { embedText, matchEmailSelectionCriteria } from "../ollama";
import type { AccountConfig } from "./preview-retention";
import type { Policy } from "./repository";

const selectionReviewLimit = Number(process.env.POLICY_SELECTION_REVIEW_LIMIT ?? 100);
const selectionConsecutiveRejectionLimit = Number(process.env.POLICY_SELECTION_CONSECUTIVE_REJECTION_LIMIT ?? 3);
const selectionFullTextLimit = Number(process.env.POLICY_SELECTION_FULL_TEXT_LIMIT ?? 1000);
const minimumMeaningfulParagraphLength = 40;

export type PolicySelectionCandidatePreview = {
  connectionId: string;
  accountName: string;
  username: string;
  folder: string;
  messageId: string;
  from?: string;
  subject: string;
  date?: string;
  reason: string;
};

type LocalMessageSummary = {
  id: string;
  from?: string;
  subject: string;
  date?: string;
  fullText?: string;
  firstMeaningfulParagraph?: string;
};

type SimilarLocalMessageSummary = LocalMessageSummary & {
  cosineSimilarity: number;
};

type ParsedHeaders = {
  from?: string;
  subject?: string;
  date?: string;
};

export async function previewSelectionCandidates(
  account: AccountConfig,
  policies: Policy[],
): Promise<PolicySelectionCandidatePreview[]> {
  const policiesWithCriteria = policies.filter((policy) => policy.selectionCriteria?.trim());

  if (policiesWithCriteria.length === 0) {
    return [];
  }

  const messageRepository = new MessageRepository();
  const messages = await loadLocalMessagesForAccount(account, messageRepository);
  const candidates: PolicySelectionCandidatePreview[] = [];

  for (const policy of policiesWithCriteria) {
    const selectionCriteria = policy.selectionCriteria?.trim();

    if (!selectionCriteria) {
      continue;
    }

    const reviewMessages = await getSelectionReviewMessages(messages, selectionCriteria, policy, account);
    let consecutiveRejections = 0;

    for (const message of reviewMessages) {
      const selection = await matchMessageSelectionCriteria(selectionCriteria, message, account, policy);

      if (!selection.matches) {
        consecutiveRejections += 1;
        console.log(
          `Selection preview processing: ${getCosineSimilarity(message).toFixed(4)} REJECT `
          + `${consecutiveRejections}/${selectionConsecutiveRejectionLimit} `
          + `${account.name}/${policy.folderPath}: ${message.subject}: ${selection.reason}`,
        );

        if (consecutiveRejections >= selectionConsecutiveRejectionLimit) {
          console.log(
            `Selection preview stopping after ${consecutiveRejections} consecutive rejections `
            + `for ${account.name}/${policy.folderPath}`,
          );
          break;
        }

        continue;
      }

      consecutiveRejections = 0;
      console.log(
        `Selection preview processing: ${getCosineSimilarity(message).toFixed(4)} ACCEPT `
        + `${account.name}/${policy.folderPath}: ${message.subject}: ${selection.reason}`,
      );
      candidates.push({
        connectionId: policy.connectionId,
        accountName: account.name,
        username: account.username,
        folder: policy.folderPath,
        messageId: message.id,
        from: message.from,
        subject: message.subject,
        date: message.date,
        reason: selection.reason,
      });
    }
  }

  return candidates;
}

async function matchMessageSelectionCriteria(
  selectionCriteria: string,
  message: SimilarLocalMessageSummary,
  account: AccountConfig,
  policy: Policy,
): Promise<{ matches: boolean; reason: string }> {
  try {
    return await matchEmailSelectionCriteria({
      selectionCriteria,
      accountName: account.name,
      from: message.from,
      subject: message.subject,
      date: message.date,
      preview: message.fullText,
    });
  } catch (error: unknown) {
    const reason = getErrorMessage(error);
    console.error(
      `Selection preview error: ${getCosineSimilarity(message).toFixed(4)} `
      + `${account.name}/${policy.folderPath}: ${message.subject}: ${reason}`,
    );

    return {
      matches: false,
      reason: `selection error: ${reason}`,
    };
  }
}

async function loadLocalMessagesForAccount(
  account: AccountConfig,
  messageRepository: MessageRepository,
): Promise<LocalMessageSummary[]> {
  const prefix = getAccountMessagePrefix(account);
  const ids = (await messageRepository.list()).filter((id) => id.startsWith(`${prefix}-`));
  const messages = await Promise.all(ids.map(async (id) => {
    const message = await messageRepository.read(id);
    const headers = parseHeaders(message.raw);

    return {
      id,
      from: headers.from,
      subject: headers.subject ?? "(no subject)",
      date: headers.date,
      fullText: getFullMessageText(message.raw),
      firstMeaningfulParagraph: getFirstMeaningfulParagraph(message.raw),
    };
  }));

  return messages.sort((a, b) => {
    const aTime = a.date ? Date.parse(a.date) : 0;
    const bTime = b.date ? Date.parse(b.date) : 0;

    return bTime - aTime || b.id.localeCompare(a.id);
  });
}

function getAccountMessagePrefix(account: AccountConfig): string {
  return `${account.imap.host}:${account.imap.port}-${account.username}`.replace(/[^a-zA-Z0-9._@-]+/g, "-");
}

function parseHeaders(raw: Buffer): ParsedHeaders {
  const text = raw.toString("utf8");
  const headerEndIndex = text.search(/\r?\n\r?\n/);
  const headerText = headerEndIndex === -1 ? text : text.slice(0, headerEndIndex);
  const headers = new Map<string, string>();
  let currentHeader: string | undefined;

  for (const line of headerText.split(/\r?\n/)) {
    if (/^[\t ]/.test(line)) {
      if (currentHeader) {
        headers.set(currentHeader, `${headers.get(currentHeader)} ${line.trim()}`);
      }

      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    currentHeader = line.slice(0, separatorIndex).toLowerCase();
    headers.set(currentHeader, line.slice(separatorIndex + 1).trim());
  }

  return {
    from: headers.get("from"),
    subject: decodeHeader(headers.get("subject")),
    date: headers.get("date"),
  };
}

function decodeHeader(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_match, charset: string, encoding: string, encoded: string) => {
    if (!/^utf-?8$/i.test(charset)) {
      return encoded;
    }

    if (encoding.toLowerCase() === "b") {
      return Buffer.from(encoded, "base64").toString("utf8");
    }

    const quotedPrintable = encoded.replace(/_/g, " ");

    return quotedPrintable.replace(/=([0-9a-fA-F]{2})/g, (_hexMatch, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  });
}

function getFirstMeaningfulParagraph(raw: Buffer): string | undefined {
  const fullText = getFullMessageText(raw);

  if (!fullText) {
    return undefined;
  }

  const paragraphs = fullText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(isMeaningfulParagraph);

  return paragraphs[0];
}

function getFullMessageText(raw: Buffer): string | undefined {
  const text = raw.toString("utf8");
  const headerEndMatch = /\r?\n\r?\n/.exec(text);

  if (!headerEndMatch) {
    return undefined;
  }

  const body = text.slice((headerEndMatch.index ?? 0) + headerEndMatch[0].length);
  const fullText = body
    .replace(/^--[^\r\n]+$/gm, " ")
    .replace(/^Content-[^:\r\n]+:[^\r\n]*(\r?\n[ \t]+[^\r\n]*)*/gim, " ")
    .replace(/^This is a multi-part message in MIME format\.\s*$/gim, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return fullText ? fullText.slice(0, selectionFullTextLimit) : undefined;
}

function isMeaningfulParagraph(paragraph: string): boolean {
  if (paragraph.length < minimumMeaningfulParagraphLength) {
    return false;
  }

  const lowerParagraph = paragraph.toLowerCase();
  const boilerplatePhrases = [
    "unsubscribe",
    "view in browser",
    "view this email",
    "privacy policy",
    "terms of use",
    "manage your preferences",
    "add us to your address book",
  ];

  return !boilerplatePhrases.some((phrase) => lowerParagraph.includes(phrase));
}

async function getSelectionReviewMessages(
  messages: LocalMessageSummary[],
  selectionCriteria: string,
  policy: Policy,
  account: AccountConfig,
): Promise<SimilarLocalMessageSummary[]> {
  const selectionCriteriaEmbedding = await embedSelectionCriteria(selectionCriteria, account, policy);
  const similarMessages: SimilarLocalMessageSummary[] = [];

  for (const message of messages) {
    const emailEmbeddingText = formatEmailEmbeddingText(message);
    const emailEmbedding = await embedEmailText(emailEmbeddingText, message, account, policy);

    if (!emailEmbedding) {
      continue;
    }

    const similarity = cosineSimilarity(selectionCriteriaEmbedding, emailEmbedding);
    console.log(
      `Selection cosine similarity: ${similarity.toFixed(4)} ${account.name}/${policy.folderPath}: ${message.subject}`,
    );
    similarMessages.push({ ...message, cosineSimilarity: similarity });
  }

  return similarMessages
    .sort((a, b) => b.cosineSimilarity - a.cosineSimilarity)
    .slice(0, selectionReviewLimit);
}

async function embedSelectionCriteria(
  selectionCriteria: string,
  account: AccountConfig,
  policy: Policy,
): Promise<number[]> {
  try {
    return await embedText(selectionCriteria);
  } catch (error: unknown) {
    throw new Error(
      `selection criteria embedding failed for ${account.name}/${policy.folderPath}: `
      + `input=${JSON.stringify(selectionCriteria)} error=${getErrorMessage(error)}`,
    );
  }
}

function formatEmailEmbeddingText(message: LocalMessageSummary): string {
  const subject = message.subject.trim() || "(no subject)";

  return `Subject: ${subject}`;
}

async function embedEmailText(
  text: string,
  message: LocalMessageSummary,
  account: AccountConfig,
  policy: Policy,
): Promise<number[] | undefined> {
  try {
    return await embedText(text);
  } catch (error: unknown) {
    console.error(
      `Selection embedding skipped: ${account.name}/${policy.folderPath}: ${message.subject}: `
      + `input=${JSON.stringify(text)} error=${getErrorMessage(error)}`,
    );
    return undefined;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimensions differ: ${a.length} and ${b.length}`);
  }

  let dotProduct = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let index = 0; index < a.length; index += 1) {
    dotProduct += a[index] * b[index];
    aMagnitude += a[index] ** 2;
    bMagnitude += b[index] ** 2;
  }

  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function getCosineSimilarity(message: LocalMessageSummary): number {
  return "cosineSimilarity" in message && typeof message.cosineSimilarity === "number"
    ? message.cosineSimilarity
    : 0;
}
