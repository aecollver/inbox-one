export type EmailForClassification = {
  accountName: string;
  from?: string;
  subject: string;
  date?: string;
  preview?: string;
};

export type EmailClassification = {
  category: string;
  priority: "low" | "normal" | "high";
  recommendation: string;
  reason: string;
};

export type EmailSelectionInput = EmailForClassification & {
  selectionCriteria: string;
};

export type EmailSelectionResult = {
  matches: boolean;
  reason: string;
};

export type EmailSelectionBatchInput = {
  selectionCriteria: string;
  emails: Array<EmailForClassification & { messageId: string }>;
};

export type EmailSelectionBatchResult = {
  matches: Array<{
    messageId: string;
    reason: string;
  }>;
};

const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen2.5";
const ollamaEmbeddingModel = process.env.OLLAMA_EMBEDDING_MODEL ?? "qwen3-embedding";
const ollamaHost = process.env.OLLAMA_HOST ?? "http://172.20.176.1:11434";
const ollamaSelectionTimeoutMs = Number(process.env.OLLAMA_SELECTION_TIMEOUT_MS ?? 45000);
const ollamaEmbeddingTimeoutMs = Number(process.env.OLLAMA_EMBEDDING_TIMEOUT_MS ?? 120000);
const embeddingRetryLengths = [2000, 1000, 500];

async function getResponseErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  const detail = body.trim();

  return detail
    ? `${response.status} ${response.statusText}: ${detail}`
    : `${response.status} ${response.statusText}`;
}

export async function embedText(text: string): Promise<number[]> {
  try {
    return await embedTextOnce(text);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new Error(`Ollama embedding request timed out after ${ollamaEmbeddingTimeoutMs}ms`);
    }

    if (!isContextLengthError(error)) {
      throw error;
    }

    for (const retryLength of embeddingRetryLengths) {
      if (text.length <= retryLength) {
        continue;
      }

      try {
        return await embedTextOnce(text.slice(0, retryLength));
      } catch (retryError: unknown) {
        if (!isContextLengthError(retryError)) {
          throw retryError;
        }
      }
    }

    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isContextLengthError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("context length");
}

async function embedTextOnce(text: string): Promise<number[]> {
  const response = await fetch(`${ollamaHost}/api/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaEmbeddingModel,
      input: text,
    }),
    signal: AbortSignal.timeout(ollamaEmbeddingTimeoutMs),
  });

  if (response.status === 404) {
    return embedTextLegacy(text);
  }

  if (!response.ok) {
    throw new Error(`Ollama embedding request failed: ${await getResponseErrorMessage(response)}`);
  }

  const payload = (await response.json()) as {
    embedding?: number[];
    embeddings?: number[][];
  };
  const embedding = payload.embeddings?.[0] ?? payload.embedding;

  if (!embedding) {
    throw new Error("Ollama embedding response did not include an embedding.");
  }

  return embedding;
}

async function embedTextLegacy(text: string): Promise<number[]> {
  const response = await fetch(`${ollamaHost}/api/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaEmbeddingModel,
      prompt: text,
    }),
    signal: AbortSignal.timeout(ollamaEmbeddingTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding request failed: ${await getResponseErrorMessage(response)}`);
  }

  const payload = (await response.json()) as {
    embedding?: number[];
  };

  if (!payload.embedding) {
    throw new Error("Ollama embedding response did not include an embedding.");
  }

  return payload.embedding;
}

export async function classifyEmail(email: EmailForClassification): Promise<EmailClassification> {
  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 256,
      },
      messages: [
        {
          role: "system",
          content: [
            "Classify this e-mail as: School (Mitchell, McCullough, AST, College Park, general Conroe ISD or the club/activity), Security, Financial or Unknown.",
            "Recommend a priority level of low, normal or high.",
            "Recommend the follow up action: Reply Requested, Follow Up, Archive or Delete.",
            "When the follow up action is archive, suggest a retention period of 1 week, 1 month or 3 months.",
            "Respond as a JSON object with the following format: { category: string, subcategory: string, priority: string, retention: string, recommendation: string, reason: string }"
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(email),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const content = payload.message?.content;

  if (!content) {
    throw new Error("Ollama response did not include message content.");
  }

  return JSON.parse(content) as EmailClassification;
}

export async function matchEmailSelectionCriteria(email: EmailSelectionInput): Promise<EmailSelectionResult> {
  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 1024,
      },
      messages: [
        {
          role: "system",
          content: [
            "Decide whether this e-mail matches the policy selection criteria.",
            "Only mark matches true when the e-mail clearly belongs in the described policy folder.",
            "Respond as a JSON object with the following format: { matches: boolean, reason: string }",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(email),
        },
      ],
    }),
    signal: AbortSignal.timeout(ollamaSelectionTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const content = payload.message?.content;

  if (!content) {
    throw new Error("Ollama response did not include message content.");
  }

  return JSON.parse(content) as EmailSelectionResult;
}

export async function matchEmailSelectionCriteriaBatch(
  input: EmailSelectionBatchInput,
): Promise<EmailSelectionBatchResult> {
  const response = await fetch(`${ollamaHost}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 1024,
      },
      messages: [
        {
          role: "system",
          content: [
            "Decide which e-mails match the policy selection criteria.",
            "Only include messages that clearly belong in the described policy folder.",
            "Use only the provided messageId values.",
            "Respond as a JSON object with the following format: { matches: [{ messageId: string, reason: string }] }",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
    }),
    signal: AbortSignal.timeout(ollamaSelectionTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const content = payload.message?.content;

  if (!content) {
    throw new Error("Ollama response did not include message content.");
  }

  return JSON.parse(content) as EmailSelectionBatchResult;
}
