import { classifyEmail } from "./ollama";
import { MessageRepository } from "./message";

type LocalMessageSummary = {
  id: string;
  accountName: string;
  from?: string;
  subject: string;
  date?: string;
};

type ParsedHeaders = {
  from?: string;
  subject?: string;
  date?: string;
};

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

function inferAccountName(id: string): string {
  return id.replace(/-\d+$/, "");
}

async function loadLocalMessages(messageRepository: MessageRepository): Promise<LocalMessageSummary[]> {
  const ids = await messageRepository.list();
  const messages = await Promise.all(ids.map(async (id) => {
    const message = await messageRepository.read(id);
    const headers = parseHeaders(message.raw);

    return {
      id,
      accountName: inferAccountName(id),
      from: headers.from,
      subject: headers.subject ?? "(no subject)",
      date: headers.date,
    };
  }));

  return messages.sort((a, b) => {
    const aTime = a.date ? Date.parse(a.date) : 0;
    const bTime = b.date ? Date.parse(b.date) : 0;

    return bTime - aTime || b.id.localeCompare(a.id);
  });
}

export async function classifyRecentMail(messageRepository = new MessageRepository()): Promise<void> {
  const messages = await loadLocalMessages(messageRepository);

  console.log(`Classifying ${messages.length} local .eml files from ${messageRepository.getRootDir()}`);

  if (messages.length === 0) {
    console.log("No local .eml files found. Run `npm run cli -- fetch` first.");
    return;
  }

  for (const [index, message] of messages.entries()) {
    const classification = await classifyEmail({
      accountName: message.accountName,
      from: message.from,
      subject: message.subject,
      date: message.date,
    });

    console.log(`${index + 1}. [${JSON.stringify(classification)}: ${message.subject}`);
  }
}
